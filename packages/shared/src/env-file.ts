import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Writes `data` to `path` through a temp file in the same directory, then rename(2), so a crash
 * mid-write never leaves `path` torn: readers see the old or the new complete content. The temp
 * file is created exclusively with `options.mode` (an existing file's mode is replaced, not kept)
 * and removed again if the write or the rename fails. Not a durability guarantee (no fsync).
 */
export function atomicWriteFileSync(path: string, data: string, options: { mode: number }): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmpPath, data, { mode: options.mode, flag: "wx" });
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const FORBIDDEN_IN_VALUE = /[\r\n\0]/;

/**
 * Sets `KEY=value` in the env file at `path`, replacing the existing line for `key` (and any
 * duplicates of it) or appending one, and keeping every other line as it was. The file is rewritten
 * atomically with mode 0600. The value is written raw, so a newline, carriage return or NUL in it
 * would inject another variable into a file the hub sources: those are refused, as is a key that is
 * not an upper-case environment variable name. A missing file is created.
 */
export function writeEnvFileValue(path: string, key: string, value: string): void {
  if (!ENV_KEY.test(key)) throw new Error(`Invalid env var name: ${JSON.stringify(key)}`);
  if (FORBIDDEN_IN_VALUE.test(value)) throw new Error(`Refusing to write ${key}: the value contains a line break or NUL character`);

  let lines: string[] = [];
  try {
    const existing = readFileSync(path, "utf8");
    lines = existing.split("\n");
    if (lines[lines.length - 1] === "") lines.pop(); // the trailing newline, re-added below
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const assignment = new RegExp(`^\\s*${key}\\s*=`);
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!assignment.test(line)) { out.push(line); continue; }
    if (!replaced) { out.push(`${key}=${value}`); replaced = true; }
  }
  if (!replaced) out.push(`${key}=${value}`);

  atomicWriteFileSync(path, out.join("\n") + "\n", { mode: 0o600 });
}

/** The value of `key` in the env file at `path` (the last assignment, one pair of surrounding quotes
 * removed, as the hub's own loader does), or undefined if the file or the key is missing. */
export function readEnvFileValue(path: string, key: string): string | undefined {
  if (!ENV_KEY.test(key)) throw new Error(`Invalid env var name: ${JSON.stringify(key)}`);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const assignment = new RegExp(`^\\s*${key}\\s*=(.*)$`);
  let value: string | undefined;
  for (const line of contents.split("\n")) {
    const raw = assignment.exec(line)?.[1]?.trim();
    if (raw !== undefined) value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return value;
}
