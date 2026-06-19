import picomatch from "picomatch";
import RE2 from "re2";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { prisma } from "./db.js";
import { dispatchRpc, getConnection, type RpcEnvelope, type RpcError } from "./hub.js";
import { logEvent } from "./activity.js";
import { createLogger, evaluatePermissionBlob, type PermissionBlob } from "@constellation/shared";
import { config } from "./config.js";

const log = createLogger("router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  executorId: string;
  absoluteRoot: string;
  host: string;
  lastHeartbeatAt: Date | null;
}

export interface RouterError {
  code: "share_not_found" | "host_not_found" | "executor_offline" | "path_filtered" | "rate_limited" | "timeout" | "cross_host" | "ambiguous";
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

  return true;
}

// ---------------------------------------------------------------------------
// Share resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a share (and optional host filter) to an executor and its absolute
 * path root. Checks personal shares first; falls back to hub shares.
 * Returns a RouterError if the share or host isn't found.
 */
export async function resolveShare(
  userId: string,
  share: string,
  host?: string,
  userOidcSub?: string | null
): Promise<RouteResult | RouterError> {
  // Personal shares (user-scoped)
  const where = host
    ? { userId, share, executor: { host } }
    : { userId, share };

  const pathShare = await prisma.pathShare.findFirst({
    where,
    include: { executor: { select: { id: true, host: true, lastHeartbeatAt: true } } },
  });

  if (pathShare) {
    return {
      executorId: pathShare.executor.id,
      absoluteRoot: pathShare.reportedPath,
      host: pathShare.executor.host,
      lastHeartbeatAt: pathShare.executor.lastHeartbeatAt,
    };
  }

  // Hub shares — optimistic relay-side permission check using synced config
  const hubResult = await resolveHubShare(share, host, userOidcSub);
  if (hubResult) return hubResult;

  // Give a specific error if the host exists but the share doesn't.
  // Check both personal nodes (userId-scoped) and hubs (userId: null).
  if (host) {
    const hostExists = await prisma.executor.findFirst({
      where: { host, OR: [{ userId }, { userId: null }] },
    });
    if (!hostExists) {
      return { code: "host_not_found", message: `No host '${host}' found` };
    }
  }
  return { code: "share_not_found", message: `No share '${share}' found` };
}

/**
 * Looks up hub shares from the relay's synced registry and evaluates
 * optimistic access using the permission blob. Returns the route result if
 * exactly one visible share is found, an "ambiguous" error if the user has
 * access to more than one host exposing the same share name, or null if
 * none are visible.
 *
 * This is optimistic: actual enforcement happens at the hub.
 */
async function resolveHubShare(
  share: string,
  host?: string,
  userOidcSub?: string | null
): Promise<RouteResult | RouterError | null> {
  const hubShares = await prisma.hubShare.findMany({
    where: {
      share,
      ...(host ? { executor: { host } } : {}),
    },
    include: { executor: { select: { id: true, host: true, lastHeartbeatAt: true } } },
  });

  const accessible = hubShares.filter(
    (hs) => evaluatePermissionBlob(hs.permissionBlob as unknown as PermissionBlob, userOidcSub) !== "none"
  );

  if (accessible.length === 0) return null;

  // Same share name visible on more than one host the user can access — the
  // hub-share namespace is per-executor, not per-user, so this is a real
  // collision rather than a bug. Surface it rather than picking arbitrarily.
  if (accessible.length > 1) {
    const hosts = accessible.map((hs) => hs.executor.host);
    return {
      code: "ambiguous",
      message: `Share '${share}' is available on multiple hosts you have access to: ${hosts.join(", ")}. Specify host to disambiguate.`,
    };
  }

  const hs = accessible[0]!;
  return {
    executorId: hs.executor.id,
    absoluteRoot: hs.reportedPath,
    host: hs.executor.host,
    lastHeartbeatAt: hs.executor.lastHeartbeatAt,
  };
}


// ---------------------------------------------------------------------------
// Relay path filter evaluation
// ---------------------------------------------------------------------------

/**
 * Returns true if the resolved path is blocked by any active relay filter
 * for this user/executor.
 */
async function isPathFiltered(
  userId: string,
  executorId: string,
  resolvedPath: string
): Promise<boolean> {
  const filters = await prisma.relayPathFilter.findMany({
    where: {
      scopeUserId: userId,
      OR: [{ scopeExecutorId: null }, { scopeExecutorId: executorId }],
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
 * Full routing pipeline: rate check → share resolution → filter check →
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
  share: string,
  params: ToolParams,
  host?: string,
  userOidcSub?: string | null,
  userClaims?: Record<string, unknown>
): Promise<DispatchResult | RouterError> {
  const startTime = Date.now();
  const requestId = randomBytes(16).toString("hex");

  if (!checkToolRateLimit(userId, tool, params)) {
    logEvent({ userId, eventType: "rate_limited", tool, share, requestId });
    return { code: "rate_limited", message: "Rate limit exceeded. Please slow down." };
  }

  const resolved = await resolveShare(userId, share, host, userOidcSub);
  if ("code" in resolved) return resolved;

  const { executorId, absoluteRoot, host: executorHost, lastHeartbeatAt } = resolved;

  // For copy/move with dst_share: resolve the destination share and inject dst_root.
  // Scoped to the source's already-resolved host — cross-host copy/move is rejected
  // below regardless, so there's never a valid reason to consider any other host.
  let effectiveParams = params;
  if ((tool === "copy" || tool === "move") && typeof params["dst_share"] === "string") {
    const dstShare = params["dst_share"];
    const dstResolved = await resolveShare(userId, dstShare, executorHost, userOidcSub);
    if ("code" in dstResolved) return dstResolved;
    if (dstResolved.executorId !== executorId) {
      return {
        code: "cross_host",
        message: `'${share}' is on '${executorHost}' and '${dstShare}' is on '${dstResolved.host}' — cross-host move/copy is not supported`,
      };
    }
    effectiveParams = { ...params, dst_root: dstResolved.absoluteRoot };
  }

  // Apply relay-side deny filters — check every path field supplied for this call.
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
    if (await isPathFiltered(userId, executorId, candidatePath)) {
      log.info({ userId, executorId, tool, candidatePath }, "Path blocked by relay filter");
      return { code: "path_filtered", message: `Path blocked by relay filter: ${candidatePath}` };
    }
  }

  if (!getConnection(executorId)) {
    const lastSeen = lastHeartbeatAt ? formatRelativeTime(lastHeartbeatAt) : "never";
    logEvent({ userId, eventType: "tool_error", host: executorHost, tool, share, requestId, errorCode: "executor_offline" });
    return {
      code: "executor_offline",
      message: `'${share}' is on '${executorHost}', which was last seen ${lastSeen}`,
    };
  }

  const timeoutMs = config.rpcTimeoutMs;

  const { forwardedClaims } = config;
  const allClaims = userClaims ?? {};
  const filteredClaims = forwardedClaims.length > 0
    ? Object.fromEntries(Object.entries(allClaims).filter(([k]) => forwardedClaims.includes(k)))
    : allClaims;

  const envelope: RpcEnvelope = {
    request_id: requestId,
    tool,
    share,
    absolute_root: absoluteRoot,
    user_oidc_sub: userOidcSub ?? null,
    user_claims: filteredClaims,
    ...effectiveParams,
  };

  log.info({ userId, executorId, tool, share, requestId }, "Dispatching RPC");

  try {
    const response = await dispatchRpc(executorId, envelope);
    const durationMs = Date.now() - startTime;

    if (response.error) {
      log.info({ userId, executorId, tool, requestId, error: response.error }, "RPC returned error");
      logEvent({
        userId,
        eventType: "tool_call",
        host: executorHost,
        tool,
        share,
        requestId,
        durationMs,
        errorCode: response.error.code ?? "rpc_error",
        errorMessage: response.error.message,
      });
    } else {
      log.info({ userId, executorId, tool, requestId }, "RPC completed");
      logEvent({ userId, eventType: "tool_call", host: executorHost, tool, share, requestId, durationMs });
    }

    return { result: response.result, error: response.error };
  } catch (err) {
    if (err instanceof Error && err.message === "executor_disconnected") {
      log.warn({ userId, executorId, tool, requestId }, "RPC failed — executor disconnected");
      logEvent({ userId, eventType: "tool_error", host: executorHost, tool, share, requestId, errorCode: "executor_disconnected" });
      return { code: "executor_offline", message: `'${executorHost}' disconnected before responding` };
    }
    if (err instanceof Error && err.message === "timeout") {
      log.warn({ userId, executorId, tool, requestId }, "RPC timed out");
      logEvent({ userId, eventType: "tool_error", host: executorHost, tool, share, requestId, errorCode: "timeout" });
      return { code: "timeout", message: `No response from '${executorHost}' within ${timeoutMs / 1000}s` };
    }
    throw err;
  }
}
