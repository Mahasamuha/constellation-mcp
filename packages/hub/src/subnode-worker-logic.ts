/**
 * Pure IPC message types and handlers for the subnode worker, split out from
 * subnode-worker.ts so they can be unit tested without forking a real worker
 * process or dropping privileges — importing subnode-worker.ts directly runs
 * its privilege-drop bootstrap as a side effect and calls process.exit(1)
 * outside of a forked context.
 */

import { createLogger, type ToolResult } from "@constellation/shared";

const log = createLogger("hub:subnode-worker");

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

export interface SubnodeInit {
  type: "init";
  shares: Record<string, string>;
  max_file_size_kb: number;
}

export interface SubnodeRequest {
  type: "request";
  request_id: string;
  tool: string;
  share: string;
  params: unknown;
}

export interface SubnodeReady {
  type: "ready";
}

export interface SubnodeResponse {
  type: "response";
  request_id: string;
  result?: unknown;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Message validator
// ---------------------------------------------------------------------------

export function isValidMessage(msg: unknown): msg is SubnodeInit | SubnodeRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m["type"] === "init") {
    return typeof m["shares"] === "object" && m["shares"] !== null
      && typeof m["max_file_size_kb"] === "number";
  }
  if (m["type"] === "request") {
    return typeof m["request_id"] === "string"
      && typeof m["tool"] === "string"
      && typeof m["share"] === "string";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request execution
// ---------------------------------------------------------------------------

export interface MinimalExecutor {
  execute(tool: string, share: string, params: unknown): Promise<ToolResult>;
}

export async function handleRequest(
  executor: MinimalExecutor,
  msg: SubnodeRequest,
  send: (msg: SubnodeResponse) => void
): Promise<void> {
  const { request_id, tool, share, params } = msg;

  try {
    const result = await executor.execute(tool, share, params);
    if (result.isError) {
      send({ type: "response", request_id, error: result.content });
    } else {
      send({ type: "response", request_id, result: result.content });
    }
  } catch (err) {
    // FileExecutor.execute() already catches and sanitizes its own errors —
    // reaching here means something unexpected escaped it. Log full detail,
    // return a generic message (err.message could carry OS-level detail,
    // e.g. an absolute path from an uncaught fs error).
    log.error({ err, request_id, tool }, "Unexpected error escaped FileExecutor.execute");
    send({ type: "response", request_id, error: { message: "Internal error" } });
  }
}
