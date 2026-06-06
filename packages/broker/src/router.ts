import picomatch from "picomatch";
import RE2 from "re2";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { prisma } from "./db.js";
import { dispatchRpc, getConnection, type RpcEnvelope, type RpcError } from "./hub.js";
import { createLogger } from "@constellation/shared";
import { config } from "./config.js";

const log = createLogger("router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  agentId: string;
  absoluteRoot: string;
  host: string;
  lastHeartbeatAt: Date | null;
}

export interface RouterError {
  code: "label_not_found" | "host_not_found" | "agent_offline" | "path_filtered" | "rate_limited" | "timeout" | "cross_host";
  message: string;
}

// ---------------------------------------------------------------------------
// Rate limiting — per-user sliding window
// ---------------------------------------------------------------------------

const toolCallTimestamps = new Map<string, number[]>();
const expensiveToolTimestamps = new Map<string, number[]>();


const EXPENSIVE_TOOLS = new Set(["grep_files", "find_files"]);

function isExpensive(tool: string, params: Record<string, unknown>): boolean {
  if (EXPENSIVE_TOOLS.has(tool)) return true;
  if (tool === "list_directory" && params["recursive"] === true) return true;
  return false;
}

function checkToolRateLimit(userId: string, tool: string, params: Record<string, unknown>): boolean {
  const now = Date.now();
  const window = 60_000;

  const standardLimit = config.rateLimits.toolCallsPerMin;
  const expensiveLimit = config.rateLimits.expensiveToolsPerMin;

  const standardTs = (toolCallTimestamps.get(userId) ?? []).filter((t) => now - t < window);
  standardTs.push(now);
  toolCallTimestamps.set(userId, standardTs);
  if (standardTs.length > standardLimit) return false;

  if (isExpensive(tool, params)) {
    const expensiveTs = (expensiveToolTimestamps.get(userId) ?? []).filter((t) => now - t < window);
    expensiveTs.push(now);
    expensiveToolTimestamps.set(userId, expensiveTs);
    if (expensiveTs.length > expensiveLimit) return false;
  }

  // Prune map entries for users who have gone quiet to prevent unbounded growth.

  return true;
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a label (and optional host filter) to an agent and its absolute
 * path root. Checks personal labels first; falls back to shared labels.
 * Returns a RouterError if the label or host isn't found.
 */
export async function resolveLabel(
  userId: string,
  label: string,
  host?: string,
  userOidcSub?: string | null
): Promise<RouteResult | RouterError> {
  // Personal labels (user-scoped)
  const where = host
    ? { userId, label, agent: { host } }
    : { userId, label };

  const pathLabel = await prisma.pathLabel.findFirst({
    where,
    include: { agent: { select: { id: true, host: true, lastHeartbeatAt: true } } },
  });

  if (pathLabel) {
    return {
      agentId: pathLabel.agent.id,
      absoluteRoot: pathLabel.reportedPath,
      host: pathLabel.agent.host,
      lastHeartbeatAt: pathLabel.agent.lastHeartbeatAt,
    };
  }

  // Shared labels — optimistic broker-side permission check using synced config
  const sharedResult = await resolveSharedLabel(label, host, userOidcSub);
  if (sharedResult) return sharedResult;

  // Give a specific error if the host exists but the label doesn't
  if (host) {
    const hostExists = await prisma.agent.findFirst({ where: { userId, host } });
    if (!hostExists) {
      return { code: "host_not_found", message: `No host '${host}' registered on your account` };
    }
  }
  return { code: "label_not_found", message: `No label '${label}' found on your account` };
}

/**
 * Looks up shared labels from the broker's synced registry and evaluates
 * optimistic access using the permission blob. Returns the route result if
 * a visible label is found, or null if not.
 *
 * This is optimistic: actual enforcement happens at the shared agent.
 */
async function resolveSharedLabel(
  label: string,
  host?: string,
  userOidcSub?: string | null
): Promise<RouteResult | null> {
  const sharedLabels = await prisma.sharedPathLabel.findMany({
    where: {
      label,
      ...(host ? { agent: { host } } : {}),
    },
    include: { agent: { select: { id: true, host: true, lastHeartbeatAt: true } } },
  });

  for (const sl of sharedLabels) {
    const access = evaluateSharedAccess(sl.permissionBlob as unknown as PermissionBlob, userOidcSub);
    if (access !== "none") {
      return {
        agentId: sl.agent.id,
        absoluteRoot: sl.reportedPath,
        host: sl.agent.host,
        lastHeartbeatAt: sl.agent.lastHeartbeatAt,
      };
    }
  }

  return null;
}

interface PermissionBlob {
  default: string;
  overrides?: Array<{ oidc_sub: string; access: string }>;
}

function evaluateSharedAccess(blob: PermissionBlob, userOidcSub?: string | null): string {
  if (userOidcSub && blob.overrides) {
    const override = blob.overrides.find((o) => o.oidc_sub === userOidcSub);
    if (override) return override.access;
  }
  return blob.default || "none";
}

// ---------------------------------------------------------------------------
// Broker path filter evaluation
// ---------------------------------------------------------------------------

/**
 * Returns true if the resolved path is blocked by any active broker filter
 * for this user/agent.
 */
async function isPathFiltered(
  userId: string,
  agentId: string,
  resolvedPath: string
): Promise<boolean> {
  const filters = await prisma.brokerPathFilter.findMany({
    where: {
      scopeUserId: userId,
      OR: [{ scopeAgentId: null }, { scopeAgentId: agentId }],
    },
  });

  for (const filter of filters) {
    if (filter.patternType === "glob") {
      if (picomatch.isMatch(resolvedPath, filter.pattern)) return true;
    } else {
      const re = new RE2(filter.pattern);
      if (re.test(resolvedPath)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// RPC dispatch
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export type ToolParams = Record<string, unknown>;

export interface DispatchResult {
  result?: object;
  error?: RpcError;
}

/**
 * Full routing pipeline: rate check → label resolution → filter check →
 * liveness check → RPC forward → result.
 */
/** Removes expired sliding-window entries. Called periodically from index.ts. */
export function pruneRateLimits(): void {
  const now = Date.now();
  const window = 60_000;
  for (const [k, ts] of toolCallTimestamps) {
    const fresh = ts.filter((t) => now - t < window);
    if (fresh.length === 0) toolCallTimestamps.delete(k);
    else toolCallTimestamps.set(k, fresh);
  }
  for (const [k, ts] of expensiveToolTimestamps) {
    const fresh = ts.filter((t) => now - t < window);
    if (fresh.length === 0) expensiveToolTimestamps.delete(k);
    else expensiveToolTimestamps.set(k, fresh);
  }
}

export async function routeToolCall(
  userId: string,
  tool: string,
  label: string,
  params: ToolParams,
  host?: string,
  userOidcSub?: string | null,
  userClaims?: Record<string, unknown>
): Promise<DispatchResult | RouterError> {
  if (!checkToolRateLimit(userId, tool, params)) {
    return { code: "rate_limited", message: "Rate limit exceeded. Please slow down." };
  }

  const resolved = await resolveLabel(userId, label, host, userOidcSub);
  if ("code" in resolved) return resolved;

  const { agentId, absoluteRoot, host: agentHost, lastHeartbeatAt } = resolved;

  // For copy/move with dst_label: resolve the destination label and inject dst_root.
  let effectiveParams = params;
  if ((tool === "copy" || tool === "move") && typeof params["dst_label"] === "string") {
    const dstLabel = params["dst_label"];
    const dstResolved = await resolveLabel(userId, dstLabel, undefined, userOidcSub);
    if ("code" in dstResolved) return dstResolved;
    if (dstResolved.agentId !== agentId) {
      return {
        code: "cross_host",
        message: `'${label}' is on '${agentHost}' and '${dstLabel}' is on '${dstResolved.host}' — cross-host move/copy is not supported`,
      };
    }
    effectiveParams = { ...params, dst_root: dstResolved.absoluteRoot };
  }

  // Apply broker-side deny filters — check every path field supplied for this call.
  // Use join() rather than string concatenation so traversal sequences (e.g. "../../x")
  // are normalized before filter matching — otherwise a crafted relative_path can bypass filters.
  const pathsToFilter: string[] = [];
  const relPath = typeof effectiveParams["relative_path"] === "string" ? effectiveParams["relative_path"] : "";
  pathsToFilter.push(relPath ? join(absoluteRoot, relPath) : absoluteRoot);
  const srcRelPath = typeof effectiveParams["src_relative_path"] === "string" ? effectiveParams["src_relative_path"] : "";
  if (srcRelPath) pathsToFilter.push(join(absoluteRoot, srcRelPath));
  const dstRelPath = typeof effectiveParams["dst_relative_path"] === "string" ? effectiveParams["dst_relative_path"] : "";
  if (dstRelPath) {
    const dstRoot = typeof effectiveParams["dst_root"] === "string" ? effectiveParams["dst_root"] : absoluteRoot;
    pathsToFilter.push(join(dstRoot, dstRelPath));
  }

  for (const candidatePath of pathsToFilter) {
    if (await isPathFiltered(userId, agentId, candidatePath)) {
      log.info({ userId, agentId, tool, candidatePath }, "Path blocked by broker filter");
      return { code: "path_filtered", message: `Path blocked by broker filter: ${candidatePath}` };
    }
  }

  if (!getConnection(agentId)) {
    const lastSeen = lastHeartbeatAt ? formatRelativeTime(lastHeartbeatAt) : "never";
    return {
      code: "agent_offline",
      message: `'${label}' is on '${agentHost}', which was last seen ${lastSeen}`,
    };
  }

  const requestId = randomBytes(16).toString("hex");
  const timeoutMs = config.rpcTimeoutMs;

  const { forwardedClaims } = config;
  const allClaims = userClaims ?? {};
  const filteredClaims = forwardedClaims.length > 0
    ? Object.fromEntries(Object.entries(allClaims).filter(([k]) => forwardedClaims.includes(k)))
    : allClaims;

  const envelope: RpcEnvelope = {
    request_id: requestId,
    tool,
    label,
    absolute_root: absoluteRoot,
    user_oidc_sub: userOidcSub ?? null,
    user_claims: filteredClaims,
    ...effectiveParams,
  };

  log.info({ userId, agentId, tool, label, requestId }, "Dispatching RPC");

  try {
    const response = await dispatchRpc(agentId, envelope);

    if (response.error) {
      log.info({ userId, agentId, tool, requestId, error: response.error }, "RPC returned error");
    } else {
      log.info({ userId, agentId, tool, requestId }, "RPC completed");
    }

    return { result: response.result, error: response.error };
  } catch (err) {
    if (err instanceof Error && err.message === "agent_disconnected") {
      log.warn({ userId, agentId, tool, requestId }, "RPC failed — agent disconnected");
      return { code: "agent_offline", message: `'${agentHost}' disconnected before responding` };
    }
    if (err instanceof Error && err.message === "timeout") {
      log.warn({ userId, agentId, tool, requestId }, "RPC timed out");
      return { code: "timeout", message: `No response from '${agentHost}' within ${timeoutMs / 1000}s` };
    }
    throw err;
  }
}
