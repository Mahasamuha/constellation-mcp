import { execFileSync, spawnSync } from "node:child_process";
import { platform } from "node:os";
import readline from "node:readline";

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

/** Polls fn every intervalMs until it returns a non-null value or timeoutMs elapses. */
export async function poll<T>(
  fn: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(intervalMs);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Prompts for a y/N confirmation. Returns true if user answers y/yes. */
export async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/** Masks all but the first 8 characters of a token. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 8) + "****";
}
