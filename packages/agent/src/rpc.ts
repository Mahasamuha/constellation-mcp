import { promises as fs } from "node:fs";
import { createLogger, type RpcError, type RpcResponse, type PathEntry } from "@constellation/shared";
import type { AgentConfig } from "./config.js";
import { AgentExecutor } from "./executor/index.js";

const log = createLogger("agent:rpc");

export type { RpcError, RpcResponse };

export interface RpcEnvelope {
  request_id: string;
  tool: string;
  absolute_root: string;
  [key: string]: unknown;
}

// Cache the realpath-resolved label registry so we don't re-stat every path
// on each RPC. Keyed on a JSON fingerprint of the current paths list; invalidated
// automatically when paths change (e.g. after a config_update).
let _registryKey = "";
let _registryCache: Record<string, string> = {};

async function buildLabelRegistry(paths: PathEntry[]): Promise<Record<string, string>> {
  const key = JSON.stringify(paths);
  if (key === _registryKey) return _registryCache;

  const registry: Record<string, string> = {};
  for (const p of paths) {
    try {
      registry[p.label] = await fs.realpath(p.path);
    } catch {
      // skip paths that can't be resolved at this moment
    }
  }
  _registryKey = key;
  _registryCache = registry;
  return registry;
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

  const labelRegistry = await buildLabelRegistry(paths);

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
