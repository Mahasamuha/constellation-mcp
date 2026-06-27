import { promises as fs, constants as fsConstants } from "node:fs";
import { join, relative } from "node:path";
import { openNoFollow } from "./safe-open.js";
import picomatch from "picomatch";
import safeRegex from "safe-regex2";

// ---------------------------------------------------------------------------
// find_files
// ---------------------------------------------------------------------------

export interface FindFilesParams {
  pattern: string;
  type?: "glob" | "regex";
}

export interface FindFilesResult {
  matches: string[];
  truncated: boolean;
}

export async function findFiles(
  root: string,
  base: string,
  params: FindFilesParams
): Promise<FindFilesResult> {
  if (params.type === "regex" && !safeRegex(params.pattern)) {
    throw new Error("Pattern rejected: potential ReDoS vulnerability");
  }
  const re = params.type === "regex" ? new RegExp(params.pattern) : null;
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
        : picomatch.isMatch(entry.name, params.pattern);

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
// grep_files
// ---------------------------------------------------------------------------

export interface GrepFilesParams {
  pattern: string;
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
  base: string,
  params: GrepFilesParams
): Promise<GrepFilesResult> {
  const isRegex = params.type === "regex";
  if (isRegex && !safeRegex(params.pattern)) {
    throw new Error("Pattern rejected: potential ReDoS vulnerability");
  }
  if (params.file_glob && !safeRegex(picomatch.makeRe(params.file_glob).source)) {
    throw new Error("file_glob rejected: potential ReDoS vulnerability");
  }
  const re = isRegex
    ? new RegExp(params.pattern, "g")
    : null;

  const matchCap = 50;
  const sizeCap = 100 * 1024;
  const fileSizeCap = 10 * 1024 * 1024;
  let totalMatches = 0;
  let totalSize = 0;
  let truncated = false;

  const resultMap = new Map<string, GrepMatch[]>();

  async function searchInFile(filePath: string): Promise<void> {
    if (truncated) return;
    const relPath = relative(root, filePath);
    const fstat = await fs.lstat(filePath);
    if (!fstat.isFile()) return; // TOCTOU: file may have been swapped for a symlink
    if (fstat.size > fileSizeCap) return;
    // O_NOFOLLOW closes the remaining TOCTOU window between lstat and read
    let handle: fs.FileHandle;
    try {
      handle = await openNoFollow(filePath, fsConstants.O_RDONLY);
    } catch {
      return; // swapped to a symlink after lstat — skip silently
    }
    let content: string;
    try {
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      if (truncated) break;
      const line = lines[i]!;
      const matched = re
        ? re.test(line)
        : line.includes(params.pattern);

      if (re) re.lastIndex = 0;

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
          if (params.file_glob && !picomatch.isMatch(entry.name, params.file_glob)) continue;
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
