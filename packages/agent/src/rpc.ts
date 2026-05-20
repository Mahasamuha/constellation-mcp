import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@constellation/shared";
import type { AgentConfig, PathEntry } from "./config.js";
import {
  listDirectory,
  fileInfo,
  searchFiles,
  readFile,
  grepFiles,
  writeFile,
  editFile,
  copyPath,
  createDirectory,
  deletePath,
  movePath,
} from "./ops.js";

const log = createLogger("agent:rpc");

export interface RpcEnvelope {
  request_id: string;
  tool: string;
  absolute_root: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  request_id: string;
  result?: unknown;
  error?: unknown;
}

/**
 * Validates absolute_root against the local paths allowlist, resolves the
 * final path (traversal + symlink check), and dispatches to the appropriate
 * file operation. Returns a structured RPC response.
 */
export async function handleRpc(
  envelope: RpcEnvelope,
  paths: PathEntry[],
  config: AgentConfig
): Promise<RpcResponse> {
  const { request_id, tool, absolute_root } = envelope;

  // Validate absolute_root against the local allowlist — agent is the security boundary.
  const allowed = paths.find((p) => p.path === absolute_root);
  if (!allowed) {
    log.warn({ tool, absolute_root }, "Path rejected by agent — not in allowlist");
    return { request_id, error: "Path rejected by agent" };
  }

  // Resolve the root to its real path (follows symlinks, canonicalises).
  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(absolute_root);
  } catch {
    return { request_id, error: "Path rejected by agent" };
  }

  // For operations that take a relative_path, validate the resolved final path
  // doesn't escape the root (traversal + symlink escape check).
  const relativePath = typeof envelope["relative_path"] === "string"
    ? envelope["relative_path"]
    : undefined;

  if (relativePath) {
    const candidate = join(resolvedRoot, relativePath);
    let resolved: string;
    try {
      // Use realpath on the parent for paths that may not exist yet (write/mkdir).
      resolved = await safeRealpath(candidate, resolvedRoot);
    } catch {
      return { request_id, error: "Path rejected by agent" };
    }
    if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
      log.warn({ tool, resolvedRoot, resolved }, "Path traversal attempt rejected");
      return { request_id, error: "Path rejected by agent" };
    }
  }

  try {
    const result = await dispatch(tool, resolvedRoot, envelope, config);
    return { request_id, result };
  } catch (err) {
    const e = err as Error & { code?: string; edit_index?: number; match_count?: number };
    if (e.code === "EDIT_NO_MATCH" || e.code === "EDIT_AMBIGUOUS") {
      return {
        request_id,
        error: { message: e.message, edit_index: e.edit_index, match_count: e.match_count },
      };
    }
    if (e.code === "FILE_TOO_LARGE") {
      return { request_id, error: e.message };
    }
    if (e.code === "DEST_EXISTS") {
      return { request_id, error: e.message };
    }
    log.error({ err, tool, request_id }, "RPC operation failed");
    return { request_id, error: e.message ?? "Internal error" };
  }
}

async function dispatch(
  tool: string,
  root: string,
  env: RpcEnvelope,
  config: AgentConfig
): Promise<object> {
  switch (tool) {
    case "list_directory":
      return listDirectory(root, {
        relative_path: s(env, "relative_path"),
        recursive: b(env, "recursive"),
        max_depth: n(env, "max_depth"),
        limit: n(env, "limit"),
        exclude: arr(env, "exclude"),
      });

    case "file_info":
      return fileInfo(root, req(env, "relative_path"));

    case "search_files":
      return searchFiles(root, {
        pattern: req(env, "pattern"),
        relative_path: s(env, "relative_path"),
        type: (env["type"] as "glob" | "regex" | undefined),
      });

    case "read_file":
      return readFile(root, {
        relative_path: req(env, "relative_path"),
        start_line: n(env, "start_line"),
        end_line: n(env, "end_line"),
        max_file_size_kb: config.max_file_size_kb,
      });

    case "grep_files":
      return grepFiles(root, {
        pattern: req(env, "pattern"),
        relative_path: s(env, "relative_path"),
        file_glob: s(env, "file_glob"),
        type: (env["type"] as "literal" | "regex" | undefined),
      });

    case "write_file":
      await writeFile(root, {
        relative_path: req(env, "relative_path"),
        content: req(env, "content"),
        mode: (env["mode"] as "overwrite" | "append" | undefined),
      });
      return { ok: true };

    case "edit_file":
      return editFile(root, {
        relative_path: req(env, "relative_path"),
        edits: env["edits"] as Array<{ old_text: string; new_text: string }>,
        dry_run: b(env, "dry_run"),
      });

    case "copy": {
      const dstLabel = s(env, "dst_label");
      if (dstLabel && !s(env, "dst_root")) {
        throw new Error("Cross-label copy requires dst_root to be resolved by the broker");
      }
      await copyPath(root, {
        src_relative_path: req(env, "src_relative_path"),
        dst_relative_path: req(env, "dst_relative_path"),
        dst_root: dstLabel ? s(env, "dst_root") : undefined,
      });
      return { ok: true };
    }

    case "create_directory":
      await createDirectory(root, req(env, "relative_path"));
      return { ok: true };

    case "delete": {
      const summary = await deletePath(root, {
        relative_path: req(env, "relative_path"),
        recursive: b(env, "recursive"),
      });
      return summary ?? { ok: true };
    }

    case "move": {
      const dstLabel = s(env, "dst_label");
      if (dstLabel && !s(env, "dst_root")) {
        throw new Error("Cross-label move requires dst_root to be resolved by the broker");
      }
      await movePath(root, {
        src_relative_path: req(env, "src_relative_path"),
        dst_relative_path: req(env, "dst_relative_path"),
        dst_root: dstLabel ? s(env, "dst_root") : undefined,
      });
      return { ok: true };
    }

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers for extracting typed values from the envelope
// ---------------------------------------------------------------------------

function s(env: RpcEnvelope, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" ? v : undefined;
}

function req(env: RpcEnvelope, key: string): string {
  const v = env[key];
  if (typeof v !== "string") throw new Error(`Missing required parameter: ${key}`);
  return v;
}

function n(env: RpcEnvelope, key: string): number | undefined {
  const v = env[key];
  return typeof v === "number" ? v : undefined;
}

function b(env: RpcEnvelope, key: string): boolean | undefined {
  const v = env[key];
  return typeof v === "boolean" ? v : undefined;
}

function arr(env: RpcEnvelope, key: string): string[] | undefined {
  const v = env[key];
  return Array.isArray(v) ? (v as string[]) : undefined;
}

/**
 * Resolves a path to its real path. For paths that don't exist yet (e.g. write
 * targets), resolves the nearest existing parent and reconstructs the rest.
 */
async function safeRealpath(path: string, boundaryRoot: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    const { dirname: dirnameF, relative: relativeF, join: joinF } = await import("node:path");
    const parent = dirnameF(path);
    if (parent === path) throw new Error("Cannot resolve path");

    // Resolve the parent first, then verify it's still inside the boundary.
    // Using string startsWith on the unresolved parent is insufficient because
    // a path like /root/../outside passes the prefix check before resolution.
    const resolvedParent = await safeRealpath(parent, boundaryRoot);
    if (!resolvedParent.startsWith(boundaryRoot + "/") && resolvedParent !== boundaryRoot) {
      throw new Error("Cannot resolve path");
    }
    return joinF(resolvedParent, relativeF(parent, path));
  }
}
