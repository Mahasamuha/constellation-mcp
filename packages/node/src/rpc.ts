import { promises as fs } from "node:fs";
import { createLogger, FileExecutor, type RpcError, type RpcResponse, type RpcEnvelope, type PathEntry } from "@constellation/shared";
import type { NodeConfig } from "./config.js";

const log = createLogger("node:rpc");

export type { RpcError, RpcResponse, RpcEnvelope };

/**
 * Caches the realpath-resolved share registry so we don't re-stat every path
 * on each RPC. Keyed on a JSON fingerprint of the current paths list; invalidated
 * automatically when paths change (e.g. after a config_update). One instance is
 * owned by the node's connection for its lifetime.
 */
export class ShareRegistryCache {
  private key = "";
  private cache: Record<string, string> = {};

  async build(paths: PathEntry[]): Promise<Record<string, string>> {
    const key = JSON.stringify(paths);
    if (key === this.key) return this.cache;

    const registry: Record<string, string> = {};
    for (const p of paths) {
      try {
        registry[p.share] = await fs.realpath(p.path);
      } catch {
        // skip paths that can't be resolved at this moment
      }
    }
    this.key = key;
    this.cache = registry;
    return registry;
  }
}

/**
 * Validates absolute_root against the local paths allowlist, builds the share
 * registry, and delegates execution to FileExecutor.
 */
export async function handleRpc(
  envelope: RpcEnvelope,
  paths: PathEntry[],
  config: NodeConfig,
  registryCache: ShareRegistryCache
): Promise<RpcResponse> {
  const { request_id, tool, absolute_root, params } = envelope;

  const allowed = paths.find((p) => p.path === absolute_root);
  if (!allowed) {
    log.warn({ tool, absolute_root }, "Path rejected by node — not in allowlist");
    return { request_id, error: { message: "Path rejected by node" } };
  }

  const shareRegistry = await registryCache.build(paths);

  if (shareRegistry[allowed.share] === undefined) {
    log.warn({ tool, absolute_root }, "Path rejected by node — realpath failed");
    return { request_id, error: { message: "Path rejected by node" } };
  }

  const executor = new FileExecutor(shareRegistry, config.max_file_size_kb);
  const result = await executor.execute(tool, allowed.share, params);

  if (result.isError) {
    return { request_id, error: result.content as RpcError };
  }
  return { request_id, result: result.content as object };
}
