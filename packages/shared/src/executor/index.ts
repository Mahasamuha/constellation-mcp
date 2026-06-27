import { join, sep } from "node:path";
import { createLogger } from "../logger.js";
import { listDirectory, fileInfo, readFile } from "./tools/fs-read.js";
import { writeFile, createDirectory, deletePath, movePath, copyPath } from "./tools/fs-write.js";
import { findFiles, grepFiles } from "./tools/fs-search.js";
import { editFile } from "./tools/fs-edit.js";
import { safeRealpath } from "./tools/safe-path.js";

const log = createLogger("executor");

export interface ToolResult {
  content: unknown;
  isError?: boolean;
}

const KNOWN_CODES = new Set(["FILE_TOO_LARGE", "READ_TOO_LARGE", "WRITE_TOO_LARGE", "EDIT_NO_MATCH", "EDIT_AMBIGUOUS", "DEST_EXISTS", "MOVE_INCOMPLETE", "SRC_IS_SYMLINK"]);

// MOVE_INCOMPLETE is "known" in the sense that its message is deliberately constructed and
// caller-safe (see crossDeviceMove in fs-write.ts), but unlike the other known codes it
// reflects a real fs failure mid-operation rather than a benign validation rejection — it's
// always worth an operator's attention, so it's logged even though its code is known.
const ALWAYS_LOG_CODES = new Set(["MOVE_INCOMPLETE"]);

export class FileExecutor {
  constructor(
    private readonly shareRegistry: Record<string, string>,
    private readonly maxFileSizeKb: number
  ) {}

  async execute(tool: string, share: string, params: unknown): Promise<ToolResult> {
    const root = this.shareRegistry[share];
    if (root === undefined) {
      log.warn({ tool, share }, "Share not found in registry");
      return { content: { message: "Path rejected" }, isError: true };
    }

    const p = params as Record<string, unknown>;

    // Resolve destination root for cross-share ops (copy/move).
    // Prefer dst_share lookup from registry; fall back to relay-forwarded dst_root.
    let resolvedDstRoot: string | undefined;
    const dstShare = s(p, "dst_share");
    const dstRootRaw = s(p, "dst_root");

    if (dstShare !== undefined) {
      const fromRegistry = this.shareRegistry[dstShare];
      if (fromRegistry === undefined) {
        log.warn({ tool, dstShare }, "dst_share not found in registry");
        return { content: { message: "Path rejected" }, isError: true };
      }
      resolvedDstRoot = fromRegistry;
    } else if (dstRootRaw !== undefined) {
      try {
        const resolved = await safeRealpath(dstRootRaw, dstRootRaw);
        if (!Object.values(this.shareRegistry).includes(resolved)) {
          log.warn({ tool, dstRootRaw }, "dst_root not in share registry");
          return { content: { message: "Path rejected" }, isError: true };
        }
        resolvedDstRoot = resolved;
      } catch {
        log.warn({ tool, dstRootRaw }, "dst_root rejected — realpath failed");
        return { content: { message: "Path rejected" }, isError: true };
      }
    }

    // Validate relative paths for directory traversal and symlink escapes.
    const pathsToValidate: Array<{ field: string; relPath: string; boundaryRoot: string }> = [];
    const relPath = s(p, "relative_path");
    const srcRelPath = s(p, "src_relative_path");
    const dstRelPath = s(p, "dst_relative_path");

    if (relPath !== undefined) {
      pathsToValidate.push({ field: "relative_path", relPath, boundaryRoot: root });
    }
    if (srcRelPath !== undefined) {
      pathsToValidate.push({ field: "src_relative_path", relPath: srcRelPath, boundaryRoot: root });
    }
    if (dstRelPath !== undefined) {
      pathsToValidate.push({ field: "dst_relative_path", relPath: dstRelPath, boundaryRoot: resolvedDstRoot ?? root });
    }

    const resolvedPaths = new Map<string, string>();

    for (const { field, relPath: rp, boundaryRoot } of pathsToValidate) {
      const candidate = join(boundaryRoot, rp);
      try {
        const resolved = await safeRealpath(candidate, boundaryRoot);
        if (!resolved.startsWith(boundaryRoot + sep) && resolved !== boundaryRoot) {
          log.warn({ tool, field, resolved, boundaryRoot }, "Path traversal attempt rejected");
          return { content: { message: "Path rejected" }, isError: true };
        }
        resolvedPaths.set(field, resolved);
      } catch (err) {
        log.warn({ tool, field, rp, err }, "safeRealpath failed");
        return { content: { message: "Path rejected" }, isError: true };
      }
    }

    // Mutation operations must not target a share root directory itself.
    // "relative_path" / "src_relative_path" / "dst_relative_path" that resolve
    // to the root of their respective share are rejected.
    const MUTATION_ROOT_FIELDS: Record<string, string[]> = {
      write_file:       ["relative_path"],
      edit_file:        ["relative_path"],
      create_directory: ["relative_path"],
      delete:           ["relative_path"],
      move:             ["src_relative_path", "dst_relative_path"],
      copy:             ["src_relative_path", "dst_relative_path"],
    };
    const mutationFields = MUTATION_ROOT_FIELDS[tool];
    if (mutationFields) {
      for (const field of mutationFields) {
        const resolved = resolvedPaths.get(field);
        if (resolved === undefined) continue;
        const fieldRoot = field === "dst_relative_path" ? (resolvedDstRoot ?? root) : root;
        if (resolved === fieldRoot) {
          log.warn({ tool, field }, "Mutation targeting share root rejected");
          return { content: { message: "Path rejected" }, isError: true };
        }
      }
    }

    // Tools whose dispatch() branch assumes a resolved path field is present
    // (see the `!` assertions there). Enforced here so a request missing the
    // field gets the standard "Path rejected" response instead of an
    // uncaught TypeError deeper in dispatch().
    const REQUIRED_RESOLVED_FIELDS: Record<string, string[]> = {
      file_info:        ["relative_path"],
      read_file:        ["relative_path"],
      write_file:       ["relative_path"],
      edit_file:        ["relative_path"],
      create_directory: ["relative_path"],
      delete:           ["relative_path"],
      copy:             ["src_relative_path", "dst_relative_path"],
      move:             ["src_relative_path", "dst_relative_path"],
    };
    const requiredFields = REQUIRED_RESOLVED_FIELDS[tool];
    if (requiredFields) {
      for (const field of requiredFields) {
        if (!resolvedPaths.has(field)) {
          log.warn({ tool, field }, "Missing required path field");
          return { content: { message: "Path rejected" }, isError: true };
        }
      }
    }

    try {
      const content = await this.dispatch(tool, root, resolvedDstRoot, p, resolvedPaths);
      return { content };
    } catch (err) {
      const e = err as Error & {
        code?: string;
        edit_index?: number;
        match_count?: number;
        read_size_kb?: number;
        max_file_size_kb?: number;
        path?: string;
      };
      if (!KNOWN_CODES.has(e.code ?? "") || ALWAYS_LOG_CODES.has(e.code ?? "")) {
        log.error({ err, tool }, "Executor operation failed");
      }
      return { content: buildError(e), isError: true };
    }
  }

  private async dispatch(
    tool: string,
    root: string,
    resolvedDstRoot: string | undefined,
    p: Record<string, unknown>,
    resolvedPaths: Map<string, string>
  ): Promise<object> {
    // Operate on the realpath-resolved, boundary-checked paths computed during
    // validation — never re-derive join(root, relative_path), which would
    // re-walk (and could re-resolve differently from) any symlinks in the path.
    // The `!` assertions below are guaranteed by execute()'s REQUIRED_RESOLVED_FIELDS
    // check, which rejects the request before dispatch() is ever called if a
    // tool's required field is missing.
    const relPath = resolvedPaths.get("relative_path");
    const srcPath = resolvedPaths.get("src_relative_path");
    const dstPath = resolvedPaths.get("dst_relative_path");

    switch (tool) {
      case "list_directory":
        return listDirectory(root, relPath ?? root, {
          recursive: b(p, "recursive"),
          max_depth: n(p, "max_depth"),
          limit: n(p, "limit"),
          exclude: arr(p, "exclude"),
        });

      case "file_info":
        return fileInfo(relPath!, root);

      case "find_files":
        return findFiles(root, relPath ?? root, {
          pattern: req(p, "pattern"),
          type: p["type"] as "glob" | "regex" | undefined,
        });

      case "read_file":
        return readFile(relPath!, root, {
          start_line: n(p, "start_line"),
          end_line: n(p, "end_line"),
          max_file_size_kb: this.maxFileSizeKb,
        });

      case "grep_files":
        return grepFiles(root, relPath ?? root, {
          pattern: req(p, "pattern"),
          file_glob: s(p, "file_glob"),
          type: p["type"] as "literal" | "regex" | undefined,
        });

      case "write_file":
        await writeFile(relPath!, root, {
          content: req(p, "content"),
          mode: p["mode"] as "overwrite" | "append" | undefined,
          maxFileSizeKb: this.maxFileSizeKb,
        });
        return { ok: true };

      case "edit_file":
        return editFile(relPath!, root, req(p, "relative_path"), {
          edits: p["edits"] as Array<{ old_text: string; new_text: string }>,
          dry_run: b(p, "dry_run"),
          maxFileSizeKb: this.maxFileSizeKb,
        });

      case "copy":
        await copyPath(srcPath!, dstPath!, root, resolvedDstRoot ?? root, {
          dst_relative_path: req(p, "dst_relative_path"),
        });
        return { ok: true };

      case "create_directory":
        await createDirectory(relPath!, root);
        return { ok: true };

      case "delete": {
        const summary = await deletePath(relPath!, root, {
          relative_path: req(p, "relative_path"),
          recursive: b(p, "recursive"),
        });
        return summary ?? { ok: true };
      }

      case "move":
        await movePath(srcPath!, dstPath!, root, resolvedDstRoot ?? root, {
          dst_relative_path: req(p, "dst_relative_path"),
        });
        return { ok: true };

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Type extraction helpers
// ---------------------------------------------------------------------------

function s(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

function req(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string") throw new Error(`Missing required parameter: ${key}`);
  return v;
}

function n(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" ? v : undefined;
}

function b(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key];
  return typeof v === "boolean" ? v : undefined;
}

function arr(p: Record<string, unknown>, key: string): string[] | undefined {
  const v = p[key];
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : undefined;
}

// ---------------------------------------------------------------------------
// Error builder
// ---------------------------------------------------------------------------

/**
 * Only KNOWN_CODES errors are deliberately constructed with caller-safe
 * detail (e.g. DEST_EXISTS carries the client-supplied relative path, never
 * a resolved absolute one — see assertNotExists in fs-write.ts). Anything
 * else reaching here is an uncaught raw Node error — most often a
 * NodeJS.ErrnoException from `fs` (ENOENT/EACCES/EISDIR/...) — whose
 * `.message`/`.path` contain the resolved *absolute* filesystem path,
 * leaking the host's directory layout to the RPC caller. Full detail is
 * already logged server-side by execute()'s catch block; only a generic
 * message and the bare error code (a POSIX errno mnemonic, not
 * server-layout-revealing on its own) cross the boundary for those.
 */
function buildError(e: Error & {
  code?: string;
  edit_index?: number;
  match_count?: number;
  read_size_kb?: number;
  write_size_kb?: number;
  max_file_size_kb?: number;
  path?: string;
}): object {
  const known = KNOWN_CODES.has(e.code ?? "");

  const err: Record<string, unknown> = {
    message: known ? (e.message ?? "Internal error") : "Operation failed",
  };
  if (e.code !== undefined) err["code"] = e.code;

  if (known) {
    if (e.edit_index !== undefined)       err["edit_index"]       = e.edit_index;
    if (e.match_count !== undefined)      err["match_count"]      = e.match_count;
    if (e.read_size_kb !== undefined)     err["read_size_kb"]     = e.read_size_kb;
    if (e.write_size_kb !== undefined)    err["write_size_kb"]    = e.write_size_kb;
    if (e.max_file_size_kb !== undefined) err["max_file_size_kb"] = e.max_file_size_kb;
    if (e.path !== undefined)             err["path"]             = e.path;
  }

  return err;
}

