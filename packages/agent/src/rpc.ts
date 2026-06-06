import { promises as fs } from "node:fs";
import { createLogger } from "@constellation/shared";
import type { AgentConfig, PathEntry } from "./config.js";
import { AgentExecutor } from "./executor/index.js";

const log = createLogger("agent:rpc");

export interface RpcEnvelope {
  request_id: string;
  tool: string;
  absolute_root: string;
  [key: string]: unknown;
}

export interface RpcError {
  message: string;
  code?: string;
  /** edit_file: 0-based index of the failing edit */
  edit_index?: number;
  /** edit_file: how many times old_text matched (0 or >1) */
  match_count?: number;
  /** read_file: actual file size in KB */
  read_size_kb?: number;
  /** read_file: configured cap in KB */
  max_file_size_kb?: number;
  /** copy/move: destination path that already exists */
  path?: string;
}

export interface RpcResponse {
  request_id: string;
  result?: object;
  error?: RpcError;
}

/**
 * Validates absolute_root against the local paths allowlist, builds the label
 * registry, and delegates execution to AgentExecutor.
 */
export async function handleRpc(
  envelope: RpcEnvelope,
  paths: PathEntry[],
  config: AgentConfig
): Promise<RpcResponse> {
  const { request_id, tool, absolute_root } = envelope;

  const allowed = paths.find((p) => p.path === absolute_root);
  if (!allowed) {
    log.warn({ tool, absolute_root }, "Path rejected by agent — not in allowlist");
    return { request_id, error: { message: "Path rejected by agent" } };
  }

  // Build label registry with realpath-resolved roots.
  const labelRegistry: Record<string, string> = {};
  for (const p of paths) {
    try {
      labelRegistry[p.label] = await fs.realpath(p.path);
    } catch {
      // skip paths that can't be resolved at this moment
    }
  }

  if (labelRegistry[allowed.label] === undefined) {
    log.warn({ tool, absolute_root }, "Path rejected by agent — realpath failed");
    return { request_id, error: { message: "Path rejected by agent" } };
  }

  const executor = new AgentExecutor(labelRegistry, config.max_file_size_kb);
  const result = await executor.execute(tool, allowed.label, envelope);

  if (result.isError) {
    return { request_id, error: result.content as RpcError };
  }
  return { request_id, result: result.content as object };
}
