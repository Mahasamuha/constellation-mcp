import { promises as fs } from "node:fs";

export type SharePathResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Validates that a share path exists, is a directory, and is already in
 * canonical form (i.e. realpath === configured path). Returns the resolved
 * path on success, or a descriptive error string on failure.
 */
export async function checkSharePath(name: string, path: string): Promise<SharePathResult> {
  let resolved: string;
  try {
    resolved = await fs.realpath(path);
  } catch {
    return { ok: false, error: `share '${name}' path '${path}' does not exist or cannot be resolved` };
  }

  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, error: `share '${name}' path '${path}' is not a directory` };
  }

  if (resolved !== path) {
    return { ok: false, error: `share '${name}' path '${path}' is not canonical — use '${resolved}' in the config` };
  }

  return { ok: true, resolved };
}
