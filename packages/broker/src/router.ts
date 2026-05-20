import micromatch from "micromatch";
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";
import { dispatchRpc, getConnection } from "./hub.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  agentId: string;
  absoluteRoot: string;
  host: string;
}

export interface RouterError {
  code: "label_not_found" | "host_not_found" | "agent_offline" | "path_filtered" | "timeout";
  message: string;
}

// ---------------------------------------------------------------------------
// Rate limiting — per-user sliding window
// ---------------------------------------------------------------------------

const toolCallTimestamps = new Map<string, number[]>();
const expensiveToolTimestamps = new Map<string, number[]>();

const EXPENSIVE_TOOLS = new Set(["grep_files", "search_files"]);

function isExpensive(tool: string, params: Record<string, unknown>): boolean {
  if (EXPENSIVE_TOOLS.has(tool)) return true;
  if (tool === "list_directory" && params["recursive"] === true) return true;
  return false;
}

function checkToolRateLimit(userId: string, tool: string, params: Record<string, unknown>): boolean {
  const now = Date.now();
  const window = 60_000;

  const standardLimit = parseInt(process.env["RATE_LIMIT_TOOL_CALLS_PER_MIN"] ?? "60", 10);
  const expensiveLimit = parseInt(process.env["RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN"] ?? "20", 10);

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
// Label resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a label (and optional host filter) to an agent and its absolute
 * path root. Returns a RouterError if the label or host isn't found.
 */
export async function resolveLabel(
  userId: string,
  label: string,
  host?: string
): Promise<RouteResult | RouterError> {
  const where = host
    ? { userId, label, agent: { host } }
    : { userId, label };

  const pathLabel = await prisma.pathLabel.findFirst({
    where,
    include: { agent: { select: { id: true, host: true } } },
  });

  if (!pathLabel) {
    if (host) {
      // Check whether the host itself exists to give a more specific error.
      const hostExists = await prisma.agent.findFirst({ where: { userId, host } });
      if (!hostExists) {
        return { code: "host_not_found", message: `No host '${host}' registered on your account` };
      }
    }
    return { code: "label_not_found", message: `No label '${label}' found on your account` };
  }

  return {
    agentId: pathLabel.agent.id,
    absoluteRoot: pathLabel.reportedPath,
    host: pathLabel.agent.host,
  };
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
      if (micromatch.isMatch(resolvedPath, filter.pattern)) return true;
    } else {
      const re = new RegExp(filter.pattern);
      if (re.test(resolvedPath)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// RPC dispatch
// ---------------------------------------------------------------------------

export type ToolParams = Record<string, unknown>;

export interface DispatchResult {
  result?: unknown;
  error?: unknown;
}

/**
 * Full routing pipeline: rate check → label resolution → filter check →
 * liveness check → RPC forward → result.
 */
export async function routeToolCall(
  userId: string,
  tool: string,
  label: string,
  params: ToolParams,
  host?: string
): Promise<DispatchResult | RouterError> {
  if (!checkToolRateLimit(userId, tool, params)) {
    return {
      code: "path_filtered",
      message: "Rate limit exceeded. Please slow down.",
    };
  }

  const resolved = await resolveLabel(userId, label, host);
  if ("code" in resolved) return resolved;

  const { agentId, absoluteRoot, host: agentHost } = resolved;

  // Apply broker-side deny filters against the resolved root path.
  const relativePath = typeof params["relative_path"] === "string" ? params["relative_path"] : "";
  const candidatePath = relativePath ? `${absoluteRoot}/${relativePath}` : absoluteRoot;

  if (await isPathFiltered(userId, agentId, candidatePath)) {
    log.info({ userId, agentId, tool, candidatePath }, "Path blocked by broker filter");
    return { code: "path_filtered", message: "Path rejected by agent" };
  }

  if (!getConnection(agentId)) {
    return {
      code: "agent_offline",
      message: `'${label}' is on '${agentHost}', which is currently offline`,
    };
  }

  const requestId = randomBytes(16).toString("hex");
  const envelope: Record<string, unknown> = {
    request_id: requestId,
    tool,
    absolute_root: absoluteRoot,
    ...params,
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
    const isTimeout = err instanceof Error && err.message === "timeout";
    if (isTimeout) {
      log.warn({ userId, agentId, tool, requestId }, "RPC timed out");
      return {
        code: "timeout",
        message: `No response from '${agentHost}' within ${process.env["RPC_TIMEOUT_MS"] ?? "30000"}ms`,
      };
    }
    throw err;
  }
}
