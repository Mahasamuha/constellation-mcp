import {
  promises as fs,
  constants as fsConstants,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, relative, dirname, sep } from "node:path";
import { openNoFollow } from "./safe-open.js";
import { assertPathStable } from "./safe-path.js";

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

import picomatch from "picomatch";

export interface ListDirectoryParams {
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
  base: string,
  params: ListDirectoryParams
): Promise<ListDirectoryResult> {
  const recursive = params.recursive ?? false;
  const maxDepth = params.max_depth;
  const hardCap = 10_000;
  const limit = params.limit === 0 ? hardCap : Math.min(params.limit ?? 2_000, hardCap);
  const exclude = params.exclude ?? [];

  const nodes: DirNode[] = [];
  let truncated = false;
  let limitReached = false;
  let truncatedBy: "limit" | "max_depth" | undefined;

  async function walk(dir: string, depth: number): Promise<void> {
    if (limitReached) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (limitReached) break;

      if (exclude.length > 0 && picomatch.isMatch(entry.name, exclude)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);
      const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";

      nodes.push({ path: relPath, type });

      if (nodes.length >= limit) {
        limitReached = true;
        truncated = true;
        truncatedBy = "limit";
        break;
      }

      if (recursive && type === "directory") {
        if (maxDepth !== undefined && depth + 1 > maxDepth) {
          truncated = true;
          if (!truncatedBy) truncatedBy = "max_depth";
          continue;
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

export async function fileInfo(absolutePath: string, boundaryRoot: string): Promise<FileInfoResult> {
  await assertPathStable(absolutePath, boundaryRoot);
  const stat = await fs.lstat(absolutePath);

  const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  const result: FileInfoResult = {
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    type,
  };

  if (type === "symlink") {
    const rawTarget = await fs.readlink(absolutePath);
    // Resolve relative symlinks against the symlink's own directory before boundary-checking
    const resolvedTarget = rawTarget.startsWith(sep)
      ? rawTarget
      : join(dirname(absolutePath), rawTarget);
    // Only expose the target when it stays within the share — prevents leaking
    // paths like /etc/shadow for out-of-share symlinks planted before validation
    if (resolvedTarget === boundaryRoot || resolvedTarget.startsWith(boundaryRoot + sep)) {
      result.target = rawTarget;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileParams {
  start_line?: number;
  end_line?: number;
  max_file_size_kb: number;
}

export interface ReadFileResult {
  content: string;
  total_lines: number;
}

export async function readFile(
  absolutePath: string,
  boundaryRoot: string,
  params: ReadFileParams
): Promise<ReadFileResult> {
  await assertPathStable(absolutePath, boundaryRoot);
  const handle = await openNoFollow(absolutePath, fsConstants.O_RDONLY);
  try {
    const stat = await handle.stat();
    const capBytes = params.max_file_size_kb * 1024;
    const isRangeRead = params.start_line !== undefined || params.end_line !== undefined;

    if (!isRangeRead && stat.size > capBytes) {
      throw Object.assign(
        new Error(`File is ${(stat.size / 1024 / 1024).toFixed(1)}MB; max is ${params.max_file_size_kb}KB — use start_line/end_line to read in chunks`),
        { code: "FILE_TOO_LARGE", read_size_kb: Math.round(stat.size / 1024), max_file_size_kb: params.max_file_size_kb }
      );
    }

    if (isRangeRead && stat.size > capBytes) {
      return await readRangeStreamed(handle, params, capBytes);
    }

    const raw = await handle.readFile("utf8");
    const lines = raw.split("\n");
    const totalLines = lines.length;

    if (isRangeRead) {
      const start = Math.max(0, (params.start_line ?? 1) - 1);
      const end = params.end_line !== undefined ? params.end_line : totalLines;
      const slice = lines.slice(start, end).join("\n");
      const sliceBytes = Buffer.byteLength(slice, "utf8");
      if (sliceBytes > capBytes) {
        throw Object.assign(
          new Error(`Requested range exceeds ${params.max_file_size_kb}KB — reduce the line range`),
          { code: "READ_TOO_LARGE", read_size_kb: Math.round(sliceBytes / 1024), max_file_size_kb: params.max_file_size_kb }
        );
      }
      return { content: slice, total_lines: totalLines };
    }

    return { content: raw, total_lines: totalLines };
  } finally {
    await handle.close();
  }
}

// Streams a file line-by-line to extract a range without loading the whole file.
// Always reads to EOF so total_lines is accurate for pagination.
async function readRangeStreamed(
  handle: fs.FileHandle,
  params: ReadFileParams,
  capBytes: number
): Promise<ReadFileResult> {
  const startLine = Math.max(0, (params.start_line ?? 1) - 1);
  const endLine = params.end_line;

  const rl = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity });
  const rangeLines: string[] = [];
  let lineNum = 0;
  let totalLines = 0;
  let byteCount = 0;

  for await (const line of rl) {
    const current = lineNum++;
    totalLines++;

    const inRange = current >= startLine && (endLine === undefined || current < endLine);
    if (!inRange) continue;

    byteCount += Buffer.byteLength(line, "utf8") + 1;
    if (byteCount > capBytes) {
      throw Object.assign(
        new Error(`Requested range exceeds ${Math.round(capBytes / 1024)}KB — reduce the line range`),
        { code: "READ_TOO_LARGE", read_size_kb: Math.round(byteCount / 1024), max_file_size_kb: Math.round(capBytes / 1024) }
      );
    }
    rangeLines.push(line);
  }

  return { content: rangeLines.join("\n"), total_lines: totalLines };
}
