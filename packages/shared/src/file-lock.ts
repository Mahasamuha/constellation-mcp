import { randomBytes } from "node:crypto";
import { openSync, closeSync, writeSync, unlinkSync, statSync, readFileSync, renameSync, linkSync } from "node:fs";
import { sleep } from "./cli-util.js";

/**
 * A lock older than this belongs to a crashed process. It must be well above the longest time a
 * holder keeps the lock: the session refresh makes up to three requests (two for discovery, one
 * to refresh) of 15 seconds each, about 45 seconds, and there is no heartbeat to extend a lock
 * while it is held. A live holder is therefore never mistaken for a dead one.
 */
export const STALE_LOCK_MS = 150_000;
/** Longer than STALE_LOCK_MS, so a waiter outlasts a crashed holder's lock and takes it over
 * instead of timing out on it. */
export const LOCK_WAIT_MS = STALE_LOCK_MS + 30_000;
const RETRY_MS = 100;

/**
 * Removes the lock at `lockPath` if it is stale, and returns whether it did. The lock is moved to
 * a unique name with rename (atomic, so of several waiters that all saw a stale lock exactly one
 * succeeds) and its age is checked again on the moved file. If a live lock replaced the stale one
 * between the first check and the rename, the live lock is put back with link (which never
 * overwrites) instead of being deleted. `afterStat` is a test seam between the check and the move.
 */
export function stealStaleLock(lockPath: string, staleMs = STALE_LOCK_MS, afterStat?: () => void): boolean {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return false;
  } catch {
    return false; // released or removed by someone else meanwhile
  }
  afterStat?.();

  const moved = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(lockPath, moved);
  } catch {
    return false; // another waiter got there first
  }
  try {
    if (Date.now() - statSync(moved).mtimeMs <= staleMs) {
      // We moved a lock that was not stale after all: restore it. If someone already took the lock
      // in the meantime, link fails with EEXIST and the moved lock is simply dropped.
      try { linkSync(moved, lockPath); } catch { /* lock already re-taken */ }
      return false;
    }
    return true;
  } finally {
    try { unlinkSync(moved); } catch { /* already gone */ }
  }
}

/**
 * Runs `fn` while holding an exclusive lock file at `lockPath`, so concurrent processes
 * (two CLI invocations refreshing the same rotating refresh token) run one at a time. The
 * lock is created with O_EXCL and holds a random nonce; it is released only if the file still
 * holds that nonce, so a holder whose lock was taken over never deletes its successor's. A lock
 * older than `staleMs` is taken to belong to a crashed process and is stolen atomically (see
 * stealStaleLock). Gives up after `timeoutMs`.
 */
export async function withLockFile<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs = LOCK_WAIT_MS,
  staleMs = STALE_LOCK_MS
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const nonce = randomBytes(16).toString("hex");
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeSync(fd, nonce); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (stealStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`, { cause: err });
      await sleep(RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === nonce) unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}
