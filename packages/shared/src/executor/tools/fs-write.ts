import {
  promises as fs,
  constants as fsConstants,
} from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export interface WriteFileParams {
  content: string;
  mode?: "overwrite" | "append";
}

export async function writeFile(absolutePath: string, params: WriteFileParams): Promise<void> {
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  if (params.mode === "append") {
    await fs.appendFile(absolutePath, params.content, "utf8");
  } else {
    await fs.writeFile(absolutePath, params.content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

export async function createDirectory(absolutePath: string): Promise<void> {
  await fs.mkdir(absolutePath, { recursive: true });
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export interface DeleteParams {
  /** Client-supplied relative path — reported back, never the resolved absolute path. */
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
  absolutePath: string,
  params: DeleteParams
): Promise<DeleteSummary | void> {
  const stat = await fs.lstat(absolutePath);

  if (stat.isDirectory() && !params.recursive) {
    const { size, count } = await dirStats(absolutePath);
    return { requires_confirmation: true, path: params.relative_path, size_bytes: size, file_count: count };
  }

  await fs.rm(absolutePath, { recursive: params.recursive ?? false, force: false });
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
  /** Client-supplied relative path of the destination — reported back on conflict,
   * never the resolved absolute path. */
  dst_relative_path: string;
}

export async function movePath(srcAbsolutePath: string, dstAbsolutePath: string, params: MoveParams): Promise<void> {
  await assertNotExists(dstAbsolutePath, params.dst_relative_path);
  await fs.mkdir(dirname(dstAbsolutePath), { recursive: true });
  try {
    await fs.rename(srcAbsolutePath, dstAbsolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await crossDeviceMove(srcAbsolutePath, dstAbsolutePath, params.dst_relative_path);
  }
}

/**
 * Cross-device rename has no atomic equivalent — copy then delete is the only option, and
 * either step can fail on its own. We don't attempt to clean up after a failure: another
 * process could already be acting on whatever's left, and an automatic rollback could race
 * with it. Instead we report exactly which step failed (MOVE_INCOMPLETE) so the caller can
 * tell the user the move didn't fully land, rather than surfacing a generic error while the
 * filesystem is left in a state nobody was told about.
 */
async function crossDeviceMove(srcAbsolutePath: string, dstAbsolutePath: string, dstRelativePath: string): Promise<void> {
  try {
    await copyRecursive(srcAbsolutePath, dstAbsolutePath);
  } catch {
    throw Object.assign(
      new Error(
        `Move did not complete: copying across filesystems failed partway through. The original is untouched, but '${dstRelativePath}' may now contain a partial copy.`
      ),
      { code: "MOVE_INCOMPLETE", path: dstRelativePath }
    );
  }

  try {
    await fs.rm(srcAbsolutePath, { recursive: true });
  } catch {
    throw Object.assign(
      new Error(
        `Move did not complete: the copy to '${dstRelativePath}' succeeded, but the original could not be removed. Both now exist.`
      ),
      { code: "MOVE_INCOMPLETE", path: dstRelativePath }
    );
  }
}

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

export interface CopyParams {
  /** Client-supplied relative path of the destination — reported back on conflict,
   * never the resolved absolute path. */
  dst_relative_path: string;
}

export async function copyPath(srcAbsolutePath: string, dstAbsolutePath: string, params: CopyParams): Promise<void> {
  await assertNotExists(dstAbsolutePath, params.dst_relative_path);
  await fs.mkdir(dirname(dstAbsolutePath), { recursive: true });
  await copyRecursive(srcAbsolutePath, dstAbsolutePath);
}

/**
 * `src`/`dst` at the top level are already realpath-resolved and boundary-checked by the
 * executor dispatcher, so they can never be symlinks themselves. Entries discovered via
 * `readdir` during the walk are not re-validated against the label root, so a symlink
 * encountered here is skipped outright rather than dereferenced (which would copy whatever
 * it points to, including paths outside the label root) or recreated as a symlink at the
 * destination (which would let the destination point outside the label root too).
 */
async function copyRecursive(src: string, dst: string): Promise<void> {
  const stat = await fs.lstat(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copyRecursive(join(src, entry), join(dst, entry));
    }
  } else {
    await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL);
  }
}

/** `absolutePath` is checked on disk; `relativePath` (the client-supplied value) is what's
 * reported back — never the resolved absolute path, which would leak the host's filesystem layout. */
async function assertNotExists(absolutePath: string, relativePath: string): Promise<void> {
  try {
    await fs.access(absolutePath);
    throw Object.assign(
      new Error(`Destination already exists — delete it first or choose a different path`),
      { code: "DEST_EXISTS", path: relativePath }
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
