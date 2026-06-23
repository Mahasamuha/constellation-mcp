import { promises as fs, constants as fsConstants } from "node:fs";

/**
 * Opens a file with O_NOFOLLOW so the kernel rejects the call outright if the
 * final path component is a symlink, instead of transparently following it.
 * This is what actually closes the gap between an earlier realpath-based
 * validation and the operation that uses its result: a validated path is
 * just a string, with no lasting connection to the file it pointed to — only
 * a NOFOLLOW-protected open() is bound to the exact file that existed when
 * the check passed, immune to anything swapped in at that path afterward.
 * No-op on Windows, which has no equivalent flag; symlink creation there
 * already requires a privilege most users don't have.
 */
export async function openNoFollow(path: string, flags: number): Promise<fs.FileHandle> {
  return fs.open(path, flags | fsConstants.O_NOFOLLOW);
}
