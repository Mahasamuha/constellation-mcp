import {
  promises as fs,
  constants as fsConstants,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import micromatch from "micromatch";
import { createPatch } from "diff";

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export interface ListDirectoryParams {
  relative_path?: string;
  recursive?: boolean;
  max_depth?: number;
  limit?: number;
  exclude?: string[];
}

export interface DirNode {
  path: string;
  type: "file" | "directory" | "symlink";
}

export interface ListDirectoryResult {
  nodes: DirNode[];
  total_nodes: number;
  truncated: boolean;
  truncated_by?: "limit" | "max_depth";
}

export async function listDirectory(
  root: string,
  params: ListDirectoryParams
): Promise<ListDirectoryResult> {
  const base = params.relative_path ? join(root, params.relative_path) : root;
  const recursive = params.recursive ?? false;
  const maxDepth = params.max_depth;
  const hardCap = 10_000;
  const limit = params.limit === 0 ? hardCap : Math.min(params.limit ?? 2_000, hardCap);
  const exclude = params.exclude ?? [];

  const nodes: DirNode[] = [];
  let truncated = false;
  let truncatedBy: "limit" | "max_depth" | undefined;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (truncated) break;

      if (exclude.length > 0 && micromatch.isMatch(entry.name, exclude)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);
      const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";

      nodes.push({ path: relPath, type });

      if (nodes.length >= limit) {
        truncated = true;
        truncatedBy = "limit";
        break;
      }

      if (recursive && type === "directory") {
        if (maxDepth !== undefined && depth + 1 > maxDepth) {
          truncated = true;
          truncatedBy = "max_depth";
          break;
        }
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(base, 0);

  return { nodes, total_nodes: nodes.length, truncated, truncated_by: truncatedBy };
}

// ---------------------------------------------------------------------------
// file_info
// ---------------------------------------------------------------------------

export interface FileInfoResult {
  size: number;
  mtime: string;
  type: "file" | "directory" | "symlink";
  target?: string;
}

export async function fileInfo(root: string, relativePath: string): Promise<FileInfoResult> {
  const full = join(root, relativePath);
  const stat = await fs.lstat(full);

  const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  const result: FileInfoResult = {
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    type,
  };

  if (type === "symlink") {
    result.target = await fs.readlink(full);
  }

  return result;
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

export interface SearchFilesParams {
  pattern: string;
  relative_path?: string;
  type?: "glob" | "regex";
}

export interface SearchFilesResult {
  matches: string[];
  truncated: boolean;
}

export async function searchFiles(
  root: string,
  params: SearchFilesParams
): Promise<SearchFilesResult> {
  const base = params.relative_path ? join(root, params.relative_path) : root;
  const isRegex = params.type === "regex";
  const re = isRegex ? new RegExp(params.pattern) : null;
  const cap = 200;
  const matches: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) break;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      const matched = re
        ? re.test(entry.name)
        : micromatch.isMatch(entry.name, params.pattern);

      if (matched) {
        matches.push(relPath);
        if (matches.length >= cap) { truncated = true; break; }
      }

      if (entry.isDirectory()) await walk(fullPath);
    }
  }

  await walk(base);
  return { matches, truncated };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileParams {
  relative_path: string;
  start_line?: number;
  end_line?: number;
  max_file_size_kb: number;
}

export interface ReadFileResult {
  content: string;
  total_lines: number;
}

export async function readFile(
  root: string,
  params: ReadFileParams
): Promise<ReadFileResult> {
  const full = join(root, params.relative_path);
  const stat = await fs.stat(full);
  const capBytes = params.max_file_size_kb * 1024;

  if (params.start_line === undefined && params.end_line === undefined) {
    if (stat.size > capBytes) {
      throw Object.assign(
        new Error(`File is ${(stat.size / 1024 / 1024).toFixed(1)}MB; max for full read is ${params.max_file_size_kb}KB — use read_file with range params or grep_files`),
        { code: "FILE_TOO_LARGE" }
      );
    }
  }

  const raw = await fs.readFile(full, "utf8");
  const lines = raw.split("\n");
  const totalLines = lines.length;

  if (params.start_line !== undefined || params.end_line !== undefined) {
    const start = Math.max(0, (params.start_line ?? 1) - 1);
    const end = params.end_line !== undefined ? params.end_line : totalLines;
    return { content: lines.slice(start, end).join("\n"), total_lines: totalLines };
  }

  return { content: raw, total_lines: totalLines };
}

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

export interface GrepFilesParams {
  pattern: string;
  relative_path?: string;
  file_glob?: string;
  type?: "literal" | "regex";
}

export interface GrepMatch {
  line: number;
  text: string;
}

export interface GrepFileResult {
  file: string;
  matches: GrepMatch[];
}

export interface GrepFilesResult {
  results: GrepFileResult[];
  truncated: boolean;
}

export async function grepFiles(
  root: string,
  params: GrepFilesParams
): Promise<GrepFilesResult> {
  const base = params.relative_path ? join(root, params.relative_path) : root;
  const isRegex = params.type === "regex";
  const re = isRegex
    ? new RegExp(params.pattern, "g")
    : null;

  const matchCap = 50;
  const sizeCap = 100 * 1024;
  let totalMatches = 0;
  let totalSize = 0;
  let truncated = false;

  const resultMap = new Map<string, GrepMatch[]>();

  async function searchInFile(filePath: string): Promise<void> {
    if (truncated) return;
    const relPath = relative(root, filePath);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (truncated) break;
      const line = lines[i]!;
      const matched = re
        ? re.test(line)
        : line.includes(params.pattern);

      if (re) re.lastIndex = 0; // reset stateful regex

      if (matched) {
        const entry: GrepMatch = { line: i + 1, text: line };
        const existing = resultMap.get(relPath) ?? [];
        existing.push(entry);
        resultMap.set(relPath, existing);
        totalMatches++;
        totalSize += line.length + relPath.length + 20;

        if (totalMatches >= matchCap || totalSize >= sizeCap) {
          truncated = true;
        }
      }
    }
  }

  const baseStat = await fs.stat(base);

  if (baseStat.isFile()) {
    await searchInFile(base);
  } else {
    async function walk(dir: string): Promise<void> {
      if (truncated) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (truncated) break;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (params.file_glob && !micromatch.isMatch(entry.name, params.file_glob)) continue;
          await searchInFile(fullPath);
        }
      }
    }
    await walk(base);
  }

  const results: GrepFileResult[] = [];
  for (const [file, matches] of resultMap) {
    results.push({ file, matches });
  }

  return { results, truncated };
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export interface WriteFileParams {
  relative_path: string;
  content: string;
  mode?: "overwrite" | "append";
}

export async function writeFile(root: string, params: WriteFileParams): Promise<void> {
  const full = join(root, params.relative_path);
  await fs.mkdir(dirname(full), { recursive: true });
  if (params.mode === "append") {
    await fs.appendFile(full, params.content, "utf8");
  } else {
    await fs.writeFile(full, params.content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export interface Edit {
  old_text: string;
  new_text: string;
}

export interface EditFileParams {
  relative_path: string;
  edits: Edit[];
  dry_run?: boolean;
}

export interface EditFileResult {
  diff: string;
}

export async function editFile(root: string, params: EditFileParams): Promise<EditFileResult> {
  const full = join(root, params.relative_path);
  const original = await fs.readFile(full, "utf8");
  let content = original;

  // Validate all edits before writing.
  for (let i = 0; i < params.edits.length; i++) {
    const edit = params.edits[i]!;
    const count = countOccurrences(content, edit.old_text);
    if (count === 0) {
      throw Object.assign(
        new Error(`No match found for edit ${i} — fetch current file content and retry`),
        { code: "EDIT_NO_MATCH", edit_index: i, match_count: 0 }
      );
    }
    if (count > 1) {
      throw Object.assign(
        new Error(`${count} matches found for edit ${i} — expand old_text to include more surrounding context`),
        { code: "EDIT_AMBIGUOUS", edit_index: i, match_count: count }
      );
    }
    content = content.replace(edit.old_text, edit.new_text);
  }

  const diff = createPatch(params.relative_path, original, content);

  if (!params.dry_run) {
    await fs.writeFile(full, content, "utf8");
  }

  return { diff };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

export interface CopyParams {
  src_relative_path: string;
  dst_relative_path: string;
  dst_root?: string;
}

export async function copyPath(root: string, params: CopyParams): Promise<void> {
  const src = join(root, params.src_relative_path);
  const dstRoot = params.dst_root ?? root;
  const dst = join(dstRoot, params.dst_relative_path);

  await assertNotExists(dst);
  await fs.mkdir(dirname(dst), { recursive: true });
  await copyRecursive(src, dst);
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  const stat = await fs.lstat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copyRecursive(join(src, entry), join(dst, entry));
    }
  } else {
    await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
  }
}

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

export async function createDirectory(root: string, relativePath: string): Promise<void> {
  await fs.mkdir(join(root, relativePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export interface DeleteParams {
  relative_path: string;
  recursive?: boolean;
}

export interface DeleteSummary {
  requires_confirmation: true;
  path: string;
  size_bytes: number;
  file_count: number;
}

export async function deletePath(
  root: string,
  params: DeleteParams
): Promise<DeleteSummary | void> {
  const full = join(root, params.relative_path);
  const stat = await fs.lstat(full);

  if (stat.isDirectory() && !params.recursive) {
    const { size, count } = await dirStats(full);
    return { requires_confirmation: true, path: params.relative_path, size_bytes: size, file_count: count };
  }

  await fs.rm(full, { recursive: params.recursive ?? false, force: false });
}

async function dirStats(dir: string): Promise<{ size: number; count: number }> {
  let size = 0;
  let count = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStats(full);
      size += sub.size;
      count += sub.count;
    } else {
      const s = await fs.stat(full);
      size += s.size;
      count++;
    }
  }
  return { size, count };
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

export interface MoveParams {
  src_relative_path: string;
  dst_relative_path: string;
  dst_root?: string;
}

export async function movePath(root: string, params: MoveParams): Promise<void> {
  const src = join(root, params.src_relative_path);
  const dstRoot = params.dst_root ?? root;
  const dst = join(dstRoot, params.dst_relative_path);

  await assertNotExists(dst);
  await fs.mkdir(dirname(dst), { recursive: true });
  try {
    await fs.rename(src, dst);
  } catch (err) {
    // rename fails cross-device; fall back to copy + delete
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyRecursive(src, dst);
      await fs.rm(src, { recursive: true });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

async function assertNotExists(path: string): Promise<void> {
  try {
    await fs.access(path);
    throw Object.assign(
      new Error(`Destination '${path}' already exists — delete it first or choose a different path`),
      { code: "DEST_EXISTS" }
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
