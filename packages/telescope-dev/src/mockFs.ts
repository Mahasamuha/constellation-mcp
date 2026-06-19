// In-memory stand-in for the relay's share-resolution + filesystem tools
// (packages/relay/src/mcp.ts / router.ts), mutated in place so edits made
// through the file browser persist for the rest of the dev session.

export interface ShareConfig {
  share: string;
  host: string;
  instructions: string | null;
  modality: "personal" | "hub";
  access: "read-write" | "read-only";
}

type Node = { type: "file"; content: string; mtime: string } | { type: "directory"; mtime: string };

export class MockToolError extends Error {}

const store = new Map<string, Node>();

export const SHARES: ShareConfig[] = [
  {
    share: "constellation-project",
    host: "sirius",
    instructions: "Mock checkout of the constellation-mcp monorepo, for local telescope UI testing.",
    modality: "personal",
    access: "read-write",
  },
  {
    share: "constellation-project",
    host: "milky-way",
    instructions: "Same share name on a different host — exercises host-scoped resolution (see ADR 0017).",
    modality: "hub",
    access: "read-only",
  },
  {
    share: "notes",
    host: "sirius",
    instructions: "Scratch notes share.",
    modality: "personal",
    access: "read-write",
  },
];

function normalize(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function key(host: string, share: string, path: string): string {
  return `${host}::${share}::${normalize(path)}`;
}

function touchParentDirs(host: string, share: string, path: string): void {
  const segments = normalize(path).split("/");
  for (let i = 1; i < segments.length; i++) {
    const dirPath = segments.slice(0, i).join("/");
    const k = key(host, share, dirPath);
    if (!store.has(k)) store.set(k, { type: "directory", mtime: new Date().toISOString() });
  }
}

function setFile(host: string, share: string, path: string, content: string): void {
  store.set(key(host, share, path), { type: "file", content, mtime: new Date().toISOString() });
  touchParentDirs(host, share, path);
}

function setDir(host: string, share: string, path: string): void {
  store.set(key(host, share, path), { type: "directory", mtime: new Date().toISOString() });
  touchParentDirs(host, share, path);
}

setFile("sirius", "constellation-project", "README.md", "# Constellation MCP\n\nMock checkout for the telescope dev harness.\n");
setFile(
  "sirius",
  "constellation-project",
  "package.json",
  JSON.stringify({ name: "constellation-mcp", version: "0.5.1" }, null, 2) + "\n"
);
setFile(
  "sirius",
  "constellation-project",
  "src/index.ts",
  'export function main(): void {\n  console.log("hello from the mock filesystem");\n}\n'
);
setFile(
  "sirius",
  "constellation-project",
  "src/utils.ts",
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
);
setFile(
  "sirius",
  "constellation-project",
  "src/components/Button.tsx",
  "export function Button() {\n  return <button>Click</button>;\n}\n"
);
setDir("sirius", "constellation-project", "empty-dir");

setFile("milky-way", "constellation-project", "TODO.md", "# TODO\n\n- [ ] Try selecting this share by host\n");
setFile("milky-way", "constellation-project", "notes/ideas.md", "# Ideas\n\nAmbiguous-share-resolution demo data.\n");

setFile("sirius", "notes", "journal.md", "# Journal\n\nDay one.\n");
setFile("sirius", "notes", "recipe.txt", "Pasta:\n1. Boil water\n2. Add pasta\n3. Drain\n");

function resolveHost(hostParam: string | undefined, share: string): string {
  if (hostParam) {
    if (!SHARES.some((s) => s.share === share && s.host === hostParam)) {
      throw new MockToolError(`Share '${share}' not found on host '${hostParam}'.`);
    }
    return hostParam;
  }
  const matches = SHARES.filter((s) => s.share === share);
  if (matches.length === 0) throw new MockToolError(`Share '${share}' not found.`);
  if (matches.length > 1) {
    throw new MockToolError(
      `Share '${share}' is available on multiple hosts you have access to: ${matches.map((m) => m.host).join(", ")}. Specify host to disambiguate.`
    );
  }
  return matches[0]!.host;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*|\*|\?/g, (match) => (match === "**" ? ".*" : match === "*" ? "[^/]*" : "."));
  return new RegExp(`^${pattern}$`);
}

export function listShares(host?: string): ShareConfig[] {
  return SHARES.filter((s) => !host || s.host === host).sort((a, b) => a.share.localeCompare(b.share));
}

export function listDirectory(
  share: string,
  hostParam: string | undefined,
  relativePath = "",
  opts: { recursive?: boolean; max_depth?: number; limit?: number; exclude?: string[] } = {}
) {
  const host = resolveHost(hostParam, share);
  const base = normalize(relativePath);
  if (base && store.get(key(host, share, base))?.type !== "directory") {
    throw new MockToolError(`Path '${relativePath}' is not a directory.`);
  }

  const prefix = `${host}::${share}::`;
  const entries: { path: string; type: "file" | "directory" | "symlink" }[] = [];
  for (const [k, node] of store) {
    if (!k.startsWith(prefix)) continue;
    const path = k.slice(prefix.length);
    if (path === base) continue;
    if (base && !path.startsWith(`${base}/`)) continue;
    const rest = base ? path.slice(base.length + 1) : path;
    if (!rest) continue;
    const depth = rest.split("/").length;
    if (!opts.recursive && depth > 1) continue;
    if (opts.max_depth && depth > opts.max_depth) continue;
    if (opts.exclude?.some((pattern) => rest.split("/").includes(pattern))) continue;
    entries.push({ path, type: node.type });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const limit = opts.limit ?? entries.length;
  const truncated = entries.length > limit;
  return {
    nodes: entries.slice(0, limit),
    total_nodes: entries.length,
    truncated,
    ...(truncated ? { truncated_by: "limit" as const } : {}),
  };
}

export function fileInfo(share: string, hostParam: string | undefined, relativePath: string) {
  const host = resolveHost(hostParam, share);
  const node = store.get(key(host, share, relativePath));
  if (!node) throw new MockToolError(`Path '${relativePath}' does not exist.`);
  return node.type === "file"
    ? { size: node.content.length, mtime: node.mtime, type: "file" as const }
    : { size: 0, mtime: node.mtime, type: "directory" as const };
}

export function findFiles(
  share: string,
  hostParam: string | undefined,
  pattern: string,
  opts: { relative_path?: string; type?: "glob" | "regex" } = {}
) {
  const host = resolveHost(hostParam, share);
  const prefix = `${host}::${share}::`;
  const base = normalize(opts.relative_path ?? "");
  const matcher = opts.type === "regex" ? new RegExp(pattern) : globToRegExp(pattern);

  const matches: string[] = [];
  for (const [k, node] of store) {
    if (!k.startsWith(prefix) || node.type !== "file") continue;
    const path = k.slice(prefix.length);
    if (base && !path.startsWith(`${base}/`)) continue;
    const name = path.split("/").pop()!;
    if (matcher.test(name) || matcher.test(path)) matches.push(path);
  }
  matches.sort();
  return { matches: matches.slice(0, 200), truncated: matches.length > 200 };
}

export function readFile(
  share: string,
  hostParam: string | undefined,
  relativePath: string,
  opts: { start_line?: number; end_line?: number } = {}
) {
  const host = resolveHost(hostParam, share);
  const node = store.get(key(host, share, relativePath));
  if (!node || node.type !== "file") throw new MockToolError(`File '${relativePath}' does not exist.`);
  const lines = node.content.split("\n");
  if (opts.start_line == null && opts.end_line == null) {
    return { content: node.content, total_lines: lines.length };
  }
  const start = opts.start_line ?? 1;
  const end = opts.end_line ?? lines.length;
  return { content: lines.slice(start - 1, end).join("\n"), total_lines: lines.length };
}

export function grepFiles(
  share: string,
  hostParam: string | undefined,
  pattern: string,
  opts: { relative_path?: string; file_glob?: string; type?: "literal" | "regex" } = {}
) {
  const host = resolveHost(hostParam, share);
  const prefix = `${host}::${share}::`;
  const base = normalize(opts.relative_path ?? "");
  const matcher = opts.type === "regex" ? new RegExp(pattern) : null;
  const globMatcher = opts.file_glob ? globToRegExp(opts.file_glob) : null;

  const results: { file: string; matches: { line: number; text: string }[] }[] = [];
  for (const [k, node] of store) {
    if (!k.startsWith(prefix) || node.type !== "file") continue;
    const path = k.slice(prefix.length);
    if (base && path !== base && !path.startsWith(`${base}/`)) continue;
    if (globMatcher && !globMatcher.test(path.split("/").pop()!)) continue;

    const lineMatches: { line: number; text: string }[] = [];
    node.content.split("\n").forEach((text, i) => {
      const hit = matcher ? matcher.test(text) : text.includes(pattern);
      if (hit) lineMatches.push({ line: i + 1, text });
    });
    if (lineMatches.length) results.push({ file: path, matches: lineMatches.slice(0, 50) });
  }
  return { results, truncated: false };
}

export function writeFile(
  share: string,
  hostParam: string | undefined,
  relativePath: string,
  content: string,
  mode: "overwrite" | "append" = "overwrite"
) {
  const host = resolveHost(hostParam, share);
  const existing = store.get(key(host, share, relativePath));
  const next = mode === "append" && existing?.type === "file" ? existing.content + content : content;
  setFile(host, share, relativePath, next);
  return { ok: true as const };
}

export function editFile(
  share: string,
  hostParam: string | undefined,
  relativePath: string,
  edits: { old_text: string; new_text: string }[],
  dryRun = false
) {
  const host = resolveHost(hostParam, share);
  const node = store.get(key(host, share, relativePath));
  if (!node || node.type !== "file") throw new MockToolError(`File '${relativePath}' does not exist.`);

  let text = node.content;
  edits.forEach((edit, i) => {
    const count = text.split(edit.old_text).length - 1;
    if (count !== 1) throw new MockToolError(`Edit ${i} matched ${count} times (expected exactly 1).`);
    text = text.replace(edit.old_text, edit.new_text);
  });

  const diff = `--- ${relativePath}\n+++ ${relativePath} (mock diff — content replaced)\n`;
  if (!dryRun) setFile(host, share, relativePath, text);
  return { diff };
}

export function createDirectory(share: string, hostParam: string | undefined, relativePath: string) {
  const host = resolveHost(hostParam, share);
  setDir(host, share, relativePath);
  return { ok: true as const };
}

export function deleteEntry(share: string, hostParam: string | undefined, relativePath: string, recursive = false) {
  const host = resolveHost(hostParam, share);
  const k = key(host, share, relativePath);
  const node = store.get(k);
  if (!node) throw new MockToolError(`Path '${relativePath}' does not exist.`);

  if (node.type === "directory") {
    const prefix = `${k}/`;
    const descendants = [...store.keys()].filter((dk) => dk.startsWith(prefix));
    if (!recursive) {
      const fileCount = descendants.filter((dk) => store.get(dk)!.type === "file").length;
      const sizeBytes = descendants.reduce((sum, dk) => {
        const n = store.get(dk)!;
        return sum + (n.type === "file" ? n.content.length : 0);
      }, 0);
      return { requires_confirmation: true, path: relativePath, file_count: fileCount, size_bytes: sizeBytes };
    }
    for (const dk of descendants) store.delete(dk);
  }
  store.delete(k);
  return { ok: true };
}

function copyNode(host: string, share: string, srcPath: string, dstShare: string, dstPath: string): void {
  const srcKey = key(host, share, srcPath);
  const node = store.get(srcKey);
  if (!node) throw new MockToolError(`Source path '${srcPath}' does not exist.`);
  if (store.has(key(host, dstShare, dstPath))) {
    throw new MockToolError(`Destination '${dstPath}' already exists.`);
  }

  if (node.type === "file") {
    setFile(host, dstShare, dstPath, node.content);
    return;
  }
  setDir(host, dstShare, dstPath);
  const prefix = `${srcKey}/`;
  for (const [k, n] of store) {
    if (!k.startsWith(prefix)) continue;
    const newPath = `${dstPath}/${k.slice(prefix.length)}`;
    if (n.type === "file") setFile(host, dstShare, newPath, n.content);
    else setDir(host, dstShare, newPath);
  }
}

// Cross-host copy/move is intentionally unsupported (see ADR 0017 and the
// router's `cross_host` rejection) — dst_share is only ever resolved against
// the source's own host, never a separate dst_host.
export function copyEntry(
  share: string,
  hostParam: string | undefined,
  srcPath: string,
  dstPath: string,
  dstShare?: string
) {
  const host = resolveHost(hostParam, share);
  const targetShare = dstShare ?? share;
  if (dstShare) resolveHost(host, dstShare);
  copyNode(host, share, srcPath, targetShare, dstPath);
  return { ok: true as const };
}

export function moveEntry(
  share: string,
  hostParam: string | undefined,
  srcPath: string,
  dstPath: string,
  dstShare?: string
) {
  const host = resolveHost(hostParam, share);
  copyEntry(share, host, srcPath, dstPath, dstShare);
  const prefix = key(host, share, srcPath);
  for (const k of [...store.keys()]) {
    if (k === prefix || k.startsWith(`${prefix}/`)) store.delete(k);
  }
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Tool dispatch — mirrors the shape of packages/relay/src/mcp.ts's `ok()` /
// error results closely enough for FileBrowserApp.tsx's toolErrorMessage().
// ---------------------------------------------------------------------------

export interface MockToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function ok(data: Record<string, unknown>): MockToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function errResult(message: string): MockToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function callMockTool(name: string, args: Record<string, unknown>): MockToolResult {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  try {
    switch (name) {
      case "list_shares":
        return ok({ shares: listShares(str(args["host"])) });

      case "list_directory":
        return ok(
          listDirectory(args["share"] as string, str(args["host"]), str(args["relative_path"]) ?? "", {
            recursive: bool(args["recursive"]),
            max_depth: num(args["max_depth"]),
            limit: num(args["limit"]),
            exclude: args["exclude"] as string[] | undefined,
          })
        );

      case "file_info":
        return ok(fileInfo(args["share"] as string, str(args["host"]), args["relative_path"] as string));

      case "find_files":
        return ok(
          findFiles(args["share"] as string, str(args["host"]), args["pattern"] as string, {
            relative_path: str(args["relative_path"]),
            type: args["type"] as "glob" | "regex" | undefined,
          })
        );

      case "read_file":
        return ok(
          readFile(args["share"] as string, str(args["host"]), args["relative_path"] as string, {
            start_line: num(args["start_line"]),
            end_line: num(args["end_line"]),
          })
        );

      case "grep_files":
        return ok(
          grepFiles(args["share"] as string, str(args["host"]), args["pattern"] as string, {
            relative_path: str(args["relative_path"]),
            file_glob: str(args["file_glob"]),
            type: args["type"] as "literal" | "regex" | undefined,
          })
        );

      case "write_file":
        return ok(
          writeFile(
            args["share"] as string,
            str(args["host"]),
            args["relative_path"] as string,
            args["content"] as string,
            args["mode"] as "overwrite" | "append" | undefined
          )
        );

      case "edit_file":
        return ok(
          editFile(
            args["share"] as string,
            str(args["host"]),
            args["relative_path"] as string,
            args["edits"] as { old_text: string; new_text: string }[],
            bool(args["dry_run"])
          )
        );

      case "create_directory":
        return ok(createDirectory(args["share"] as string, str(args["host"]), args["relative_path"] as string));

      case "delete":
        return ok(
          deleteEntry(
            args["share"] as string,
            str(args["host"]),
            args["relative_path"] as string,
            bool(args["recursive"])
          )
        );

      case "copy":
        return ok(
          copyEntry(
            args["share"] as string,
            str(args["host"]),
            args["src_relative_path"] as string,
            args["dst_relative_path"] as string,
            str(args["dst_share"])
          )
        );

      case "move":
        return ok(
          moveEntry(
            args["share"] as string,
            str(args["host"]),
            args["src_relative_path"] as string,
            args["dst_relative_path"] as string,
            str(args["dst_share"])
          )
        );

      default:
        return errResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof MockToolError) return errResult(err.message);
    throw err;
  }
}
