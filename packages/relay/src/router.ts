import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { prisma } from "./db.js";
import { dispatchRpc, getConnection, type RpcEnvelope, type RpcError } from "./hub.js";
import { logEvent } from "./activity.js";
import { createLogger, evaluatePermissionBlob, filterSource, createPathFilter, type PermissionBlob } from "@constellation/shared";
import { config } from "./config.js";
import type { RequestUser } from "./request-user.js";

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
  code: "share_not_found" | "host_not_found" | "executor_offline" | "path_filtered" | "timeout" | "cross_host" | "ambiguous";
  message: string;
}

// An executor (a user's own node, or an admin's hub) is a separate process this relay
// doesn't control — nothing guarantees its RPC error fields only ever contain what
// FileExecutor's own buildError() constructs. A node/hub could be a non-standard
// implementation, or a future bug could let raw exception detail (an absolute path,
// another user's username from a hub's identity-resolution error) escape past
// whatever sanitization the executor does on its own side. Cap length and strip
// control characters here too — independently of the executor — since this is the
// single point an executor's error first enters relay-owned territory: every
// downstream consumer (toolError → the MCP client, the activity log exposed via
// /api/activity, structured logs) inherits the cleaned value rather than each having
// to remember to sanitize it themselves.
const MAX_EXECUTOR_ERROR_FIELD_LENGTH = 500;

function cleanExecutorErrorField(value: unknown, maxLength: number): string {
  const str = typeof value === "string" ? value : String(value);
  // eslint-disable-next-line no-control-regex -- deliberately stripping control chars (incl. ANSI/terminal escapes, newlines)
  const stripped = str.replace(/[\x00-\x1F\x7F]/g, "");
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

function sanitizeExecutorError(error: RpcError): RpcError {
  return {
    ...error,
    message: cleanExecutorErrorField(error.message, MAX_EXECUTOR_ERROR_FIELD_LENGTH),
    ...(error.code !== undefined ? { code: cleanExecutorErrorField(error.code, 64) } : {}),
    ...(error.path !== undefined ? { path: cleanExecutorErrorField(error.path, MAX_EXECUTOR_ERROR_FIELD_LENGTH) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting — per-user sliding window
//
// Every MCP tool call hits exactly one bucket, decided by classifyTool(). Tools
// must be explicitly listed in STANDARD_TOOLS to get the lenient bucket — anything
// not listed (a tool added later and never classified here, as much as a tool
// deliberately considered "expensive") falls through to the strict one. That's
// deliberate: the failure mode for forgetting to classify a new tool is "rate
// limited too aggressively," never "not rate limited at all." This is the one
// and only enforcement point for tool-call rate limiting — every tool handler in
// mcp.ts is required to go through checkToolRateLimit() via its registerTool()
// wrapper before doing anything else, including tools (list_hosts, list_shares)
// that never reach routeToolCall() below.
// ---------------------------------------------------------------------------

// NOTE: these are in-process Maps — rate-limit windows reset on restart and are
// not shared across relay instances. This is intentional for the single-instance
// deployment model. For multi-instance deployments, back these with a Redis store
// using express-rate-limit's store interface instead.
const toolCallTimestamps = new Map<string, number[]>();
const expensiveToolTimestamps = new Map<string, number[]>();
const mcpRequestTimestamps = new Map<string, number[]>();
/** When each user's last `rate_limited` activity event was written. */
const rateLimitedLoggedAt = new Map<string, number>();
const RATE_WINDOW_MS = 60_000;

/** Tools cheap enough for the standard per-minute budget. Anything else — including
 * any tool not listed here at all — uses the stricter expensive-tools budget. */
const STANDARD_TOOLS = new Set([
  "list_hosts",
  "list_shares",
  "open_file_browser",
  "list_directory", // unless recursive: true — see classifyTool
  "file_info",
  "read_file",
  "write_file",
  "edit_file",
  "copy",
  "create_directory",
  "delete",
  "move",
]);

export function classifyTool(tool: string, params: Record<string, unknown>): "standard" | "expensive" {
  if (tool === "list_directory" && params["recursive"] === true) return "expensive";
  return STANDARD_TOOLS.has(tool) ? "standard" : "expensive";
}

/**
 * Sliding window: true (and records the call) when `key` has made fewer than `limit` calls in
 * the last minute. Only allowed calls are recorded, so a flood of rejected calls neither grows
 * the array (it holds at most `limit` entries) nor costs more than `limit` steps per call.
 */
function allowInWindow(timestamps: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const ts = timestamps.get(key) ?? [];
  // Timestamps are appended in order, so the expired ones are at the front.
  let expired = 0;
  while (expired < ts.length && now - ts[expired]! >= RATE_WINDOW_MS) expired++;
  const live = expired > 0 ? ts.slice(expired) : ts;
  if (live.length >= limit) {
    if (expired > 0) timestamps.set(key, live);
    return false;
  }
  live.push(now);
  timestamps.set(key, live);
  return true;
}

export function checkToolRateLimit(userId: string, tool: string, params: Record<string, unknown>): boolean {
  const expensive = classifyTool(tool, params) === "expensive";
  const limit = expensive ? config.rateLimits.expensiveToolsPerMin : config.rateLimits.toolCallsPerMin;
  return allowInWindow(expensive ? expensiveToolTimestamps : toolCallTimestamps, userId, limit);
}

/** Coarse per-user ceiling on every authenticated /mcp request, tool call or not. */
export function checkMcpRequestRateLimit(userId: string): boolean {
  return allowInWindow(mcpRequestTimestamps, userId, config.rateLimits.mcpRequestsPerMin);
}

/** True at most once per user per window, so a flood of limited calls writes one activity event. */
export function shouldLogRateLimited(userId: string): boolean {
  const now = Date.now();
  const last = rateLimitedLoggedAt.get(userId);
  if (last !== undefined && now - last < RATE_WINDOW_MS) return false;
  rateLimitedLoggedAt.set(userId, now);
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
  user: RequestUser,
  share: string,
  host?: string
): Promise<RouteResult | RouterError> {
  const userId = user.id;
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
  const hubResult = await resolveHubShare(user, share, host);
  if (hubResult) return hubResult;

  // A host the user can't see answers the same whether or not it exists, so hub names can't
  // be enumerated. Only a host the user owns or can see a hub share on gets the specific error.
  if (host && !(await userCanSeeHost(user, host))) {
    return { code: "host_not_found", message: `No host '${host}' found` };
  }
  return { code: "share_not_found", message: `No share '${share}' found` };
}

/** Hub shares (optionally of one name and/or host) the user's permission blob lets them see. */
async function accessibleHubShares(user: RequestUser, filter: { share?: string; host?: string }) {
  const hubShares = await prisma.hubShare.findMany({
    where: {
      ...(filter.share !== undefined ? { share: filter.share } : {}),
      ...(filter.host ? { executor: { host: filter.host } } : {}),
    },
    include: { executor: { select: { id: true, host: true, lastHeartbeatAt: true } } },
  });
  const subject = { sub: user.id, groups: user.groups };
  return hubShares.filter(
    (hs) => evaluatePermissionBlob(hs.permissionBlob as unknown as PermissionBlob, subject) !== "none"
  );
}

/** True when the user owns an executor with this host, or can see a hub share on it. */
async function userCanSeeHost(user: RequestUser, host: string): Promise<boolean> {
  const own = await prisma.executor.findFirst({ where: { host, userId: user.id }, select: { id: true } });
  if (own) return true;
  return (await accessibleHubShares(user, { host })).length > 0;
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
  user: RequestUser,
  share: string,
  host?: string
): Promise<RouteResult | RouterError | null> {
  const accessible = await accessibleHubShares(user, { share, host });

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

/** A source that blocks every path, stored in place of a pattern that no longer compiles. */
const BLOCK_ALL_SOURCE = "(?s)^.*$";

/** Longest absolute path the relay will check or forward. */
export const MAX_CHECKED_PATH_LENGTH = 4096;

/**
 * The RE2 sources of the user's filters for this executor, built once per call: it feeds both
 * the relay's early check and the envelope the executor enforces. A stored pattern that fails
 * to compile blocks everything rather than being skipped.
 */
async function loadPathFilterSources(userId: string, executorId: string): Promise<string[]> {
  const filters = await prisma.relayPathFilter.findMany({
    where: {
      scopeUserId: userId,
      OR: [{ scopeExecutorId: null }, { scopeExecutorId: executorId }],
    },
  });
  return filters.map((f) => {
    try {
      return filterSource(f.pattern, f.patternType as "glob" | "regex");
    } catch (err) {
      log.error({ userId, executorId, filterId: f.id, err }, "Stored path filter does not compile; blocking all paths");
      return BLOCK_ALL_SOURCE;
    }
  });
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
  for (const map of [toolCallTimestamps, expensiveToolTimestamps, mcpRequestTimestamps]) {
    for (const [k, ts] of map) {
      const fresh = ts.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) map.delete(k);
      else map.set(k, fresh);
    }
  }
  for (const [k, t] of rateLimitedLoggedAt) {
    if (now - t >= RATE_WINDOW_MS) rateLimitedLoggedAt.delete(k);
  }
}

export async function routeToolCall(
  user: RequestUser,
  tool: string,
  share: string,
  params: ToolParams,
  host?: string
): Promise<DispatchResult | RouterError> {
  const userId = user.id;
  const startTime = Date.now();
  const requestId = randomBytes(16).toString("hex");

  const resolved = await resolveShare(user, share, host);
  if ("code" in resolved) return resolved;

  const { executorId, absoluteRoot, host: executorHost, lastHeartbeatAt } = resolved;

  // For copy/move with dst_share: resolve the destination share and inject dst_root.
  // Scoped to the source's already-resolved host — cross-host copy/move is rejected
  // below regardless, so there's never a valid reason to consider any other host.
  let effectiveParams = params;
  const dstShareParam = typeof params["dst_share"] === "string" ? params["dst_share"] : undefined;
  if ((tool === "copy" || tool === "move") && dstShareParam !== undefined) {
    const dstResolved = await resolveShare(user, dstShareParam, executorHost);
    if ("code" in dstResolved) return dstResolved;
    if (dstResolved.executorId !== executorId) {
      return {
        code: "cross_host",
        message: `'${share}' is on '${executorHost}' and '${dstShareParam}' is on '${dstResolved.host}' — cross-host move/copy is not supported`,
      };
    }
    effectiveParams = { ...params, dst_root: dstResolved.absoluteRoot };
  }

  // Apply relay-side deny filters — check every path field supplied for this call.
  // Use join() rather than string concatenation so traversal sequences (e.g. "../../x")
  // are normalized before filter matching — otherwise a crafted relative_path can bypass filters.
  // `label` is share-name + client-supplied relative path, never the resolved absolute
  // filesystem path — a filter meant to hide a sensitive subpath shouldn't surface its
  // absolute location to the client in the denial message. The absolute path is still
  // logged server-side below.
  const pathsToFilter: Array<{ absolute: string; label: string }> = [];
  const relPath = typeof effectiveParams["relative_path"] === "string" ? effectiveParams["relative_path"] : "";
  pathsToFilter.push({ absolute: relPath ? join(absoluteRoot, relPath) : absoluteRoot, label: relPath ? `${share}/${relPath}` : share });
  const srcRelPath = typeof effectiveParams["src_relative_path"] === "string" ? effectiveParams["src_relative_path"] : "";
  if (srcRelPath) pathsToFilter.push({ absolute: join(absoluteRoot, srcRelPath), label: `${share}/${srcRelPath}` });
  const dstRelPath = typeof effectiveParams["dst_relative_path"] === "string" ? effectiveParams["dst_relative_path"] : "";
  if (dstRelPath) {
    const dstRoot = typeof effectiveParams["dst_root"] === "string" ? effectiveParams["dst_root"] : absoluteRoot;
    const dstShareLabel = dstShareParam ?? share;
    pathsToFilter.push({ absolute: join(dstRoot, dstRelPath), label: `${dstShareLabel}/${dstRelPath}` });
  }

  // The executor enforces these again on resolved real paths; this is the cheap pre-check.
  const pathFilterSources = await loadPathFilterSources(userId, executorId);
  const pathFilter = createPathFilter(pathFilterSources);
  for (const candidate of pathsToFilter) {
    if (candidate.absolute.length > MAX_CHECKED_PATH_LENGTH) {
      return { code: "path_filtered", message: `Path is too long: ${candidate.label.slice(0, 64)}…` };
    }
    if (pathFilter.blocks(candidate.absolute)) {
      log.info({ userId, executorId, tool, candidatePath: candidate.absolute }, "Path blocked by relay filter");
      return { code: "path_filtered", message: `Path blocked by relay filter: ${candidate.label}` };
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
  const allClaims = user.claims;
  const filteredClaims = forwardedClaims.length > 0
    ? Object.fromEntries(Object.entries(allClaims).filter(([k]) => forwardedClaims.includes(k)))
    : allClaims;

  const envelope: RpcEnvelope = {
    request_id: requestId,
    tool,
    share,
    absolute_root: absoluteRoot,
    user_sub: user.id,
    // Always sent and never filtered by forwardedClaims: a group override can restrict
    // access as well as grant it, so the hub needs the full list to evaluate correctly.
    user_groups: [...user.groups],
    user_claims: filteredClaims,
    params: effectiveParams,
    path_filters: pathFilterSources,
  };

  log.info({ userId, executorId, tool, share, requestId }, "Dispatching RPC");

  try {
    const response = await dispatchRpc(executorId, envelope);
    const durationMs = Date.now() - startTime;
    const error = response.error ? sanitizeExecutorError(response.error) : undefined;

    if (error) {
      log.info({ userId, executorId, tool, requestId, error }, "RPC returned error");
      logEvent({
        userId,
        eventType: "tool_call",
        host: executorHost,
        tool,
        share,
        requestId,
        durationMs,
        errorCode: error.code ?? "rpc_error",
        errorMessage: error.message,
      });
    } else {
      log.info({ userId, executorId, tool, requestId }, "RPC completed");
      logEvent({ userId, eventType: "tool_call", host: executorHost, tool, share, requestId, durationMs });
    }

    return { result: response.result, error };
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
