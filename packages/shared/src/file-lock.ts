import { openSync, closeSync, writeSync, unlinkSync, statSync } from "node:fs";
import { sleep } from "./cli-util.js";

const STALE_LOCK_MS = 60_000;
const RETRY_MS = 100;

/**
 * Runs `fn` while holding an exclusive lock file at `lockPath`, so concurrent processes
 * (two CLI invocations refreshing the same rotating refresh token) run one at a time. The
 * lock is created with O_EXCL; a lock older than a minute is taken to belong to a crashed
 * process and removed. Gives up after `timeoutMs`.
 */
export async function withLockFile<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) unlinkSync(lockPath);
      } catch { /* released or removed by someone else meanwhile */ }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`, { cause: err });
      await sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
