import { execFileSync, spawnSync } from "node:child_process";
import { platform } from "node:os";

export function currentPlatform(): "linux" | "darwin" | "win32" | "other" {
  const p = platform();
  if (p === "linux") return "linux";
  if (p === "darwin") return "darwin";
  if (p === "win32") return "win32";
  return "other";
}

/** Runs a command and returns stdout, throwing on non-zero exit. */
export function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

/** Runs a command, inheriting stdio (for interactive tools). */
export function runInherited(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Masks all but the first 8 characters of a token. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 8) + "****";
}
