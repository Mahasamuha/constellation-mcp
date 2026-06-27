import { promises as fs } from "node:fs";
import { dirname, basename, join, sep } from "node:path";

/**
 * Resolves a path to its real path. For paths that don't exist yet (e.g. write
 * targets), resolves the nearest existing parent and reconstructs the rest.
 */
export async function safeRealpath(path: string, boundaryRoot: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;

    const parent = dirname(path);
    if (parent === path) throw new Error("Cannot resolve path", { cause: err });

    const resolvedParent = await safeRealpath(parent, boundaryRoot);
    if (!resolvedParent.startsWith(boundaryRoot + sep) && resolvedParent !== boundaryRoot) {
      throw new Error("Cannot resolve path", { cause: err });
    }
    return join(resolvedParent, basename(path));
  }
}

/**
 * Re-resolves the parent directory of `absolutePath` immediately before a
 * syscall and verifies it still resolves to itself within `boundaryRoot`.
 * Detects intermediate-component symlink swaps (TOCTOU) between the initial
 * `safeRealpath` check in `execute()` and the actual filesystem operation.
 *
 * Only the parent is checked, not the final component — the final component
 * is handled by `O_NOFOLLOW` in `openNoFollow()` for open-based operations,
 * and by `lstat`'s no-follow semantics for `fileInfo`. Checking only the
 * parent also allows valid within-share symlinks at the final position.
 */
export async function assertPathStable(absolutePath: string, boundaryRoot: string): Promise<void> {
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return; // already at filesystem root

  let reResolvedParent: string;
  try {
    try {
      reResolvedParent = await fs.realpath(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Parent doesn't exist yet (valid for write targets creating new paths).
      reResolvedParent = await safeRealpath(parent, boundaryRoot);
    }
  } catch {
    throw Object.assign(new Error("Path rejected"), { code: "PATH_REJECTED" });
  }

  if (
    reResolvedParent !== parent ||
    (!reResolvedParent.startsWith(boundaryRoot + sep) && reResolvedParent !== boundaryRoot)
  ) {
    throw Object.assign(new Error("Path rejected"), { code: "PATH_REJECTED" });
  }
}
