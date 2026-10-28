import { promises as fs } from "node:fs";
import type { createPathFilter } from "../../path-filter.js";

export type PathFilter = ReturnType<typeof createPathFilter>;

/**
 * The one place that decides whether a directory entry met during traversal is hidden by the
 * caller's relay path filters. `fullPath` is `dir/name` with `dir` already a real path, so it is
 * the entry's real path unless the entry is itself a symlink; a symlink is also checked at its
 * target, so a link cannot name content the filter blocks. A link whose target can't be resolved
 * is judged by its own path only (it exposes no content). Traversal skips a hidden entry: it is
 * not listed, counted, matched, searched or descended into.
 */
export async function entryHidden(filter: PathFilter | undefined, fullPath: string, isSymlink: boolean): Promise<boolean> {
  if (!filter || !filter.active) return false;
  if (filter.blocks(fullPath)) return true;
  if (!isSymlink) return false;
  try {
    return filter.blocks(await fs.realpath(fullPath));
  } catch {
    return false;
  }
}
