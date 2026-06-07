import {
  promises as fs,
  constants as fsConstants,
} from "node:fs";
import { join, dirname } from "node:path";

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

  await assertNotExists(dst, params.dst_relative_path);
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

  await assertNotExists(dst, params.dst_relative_path);
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

/** `absolutePath` is checked on disk; `relativePath` (the client-supplied value) is what's
 * reported back — never the resolved absolute path, which would leak the agent's filesystem layout. */
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
