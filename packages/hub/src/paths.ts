import { promises as fs } from "node:fs";

export type LabelPathResult =
  | { ok: true; resolved: string }
  | { ok: false; error: string };

/**
 * Validates that a label path exists, is a directory, and is already in
 * canonical form (i.e. realpath === configured path). Returns the resolved
 * path on success, or a descriptive error string on failure.
 */
export async function checkLabelPath(name: string, path: string): Promise<LabelPathResult> {
  let resolved: string;
  try {
    resolved = await fs.realpath(path);
  } catch {
    return { ok: false, error: `label '${name}' path '${path}' does not exist or cannot be resolved` };
  }

  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, error: `label '${name}' path '${path}' is not a directory` };
  }

  if (resolved !== path) {
    return { ok: false, error: `label '${name}' path '${path}' is not canonical — use '${resolved}' in the config` };
  }

  return { ok: true, resolved };
}
