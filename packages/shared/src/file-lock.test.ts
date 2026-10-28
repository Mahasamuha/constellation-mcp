import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLockFile, stealStaleLock, STALE_LOCK_MS, LOCK_WAIT_MS } from "./file-lock.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("withLockFile", () => {
  it("runs callers one at a time and removes the lock afterwards", async () => {
    const lock = join(dir, "x.lock");
    const order: string[] = [];
    const task = (name: string) => withLockFile(lock, async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${name}:end`);
    });
    await Promise.all([task("a"), task("b")]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock when the callback throws", async () => {
    const lock = join(dir, "x.lock");
    await expect(withLockFile(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
  });

  it("takes over a stale lock left by a crashed process", async () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "999999");
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    utimesSync(lock, old, old);
    await expect(withLockFile(lock, async () => "ok")).resolves.toBe("ok");
  });

  it("gives up after the timeout when the lock stays held", async () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, String(process.pid));
    await expect(withLockFile(lock, async () => "ok", 250)).rejects.toThrow(/Timed out/);
  });

  it("does not release a lock that now belongs to someone else", async () => {
    const lock = join(dir, "x.lock");
    await withLockFile(lock, async () => {
      // Another process stole this (apparently stale) lock and took it over.
      writeFileSync(lock, "someone-elses-nonce");
    });
    expect(readFileSync(lock, "utf8")).toBe("someone-elses-nonce");
  });

  it("waits longer than it takes a crashed holder's lock to go stale", () => {
    expect(LOCK_WAIT_MS).toBeGreaterThan(STALE_LOCK_MS);
    // Well above the ~45 s worst case of a session refresh (three 15 s requests).
    expect(STALE_LOCK_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("leaves a lock younger than the threshold alone", async () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "holder");
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    await expect(withLockFile(lock, async () => "ok", 250)).rejects.toThrow(/Timed out/);
    expect(readFileSync(lock, "utf8")).toBe("holder");
  });
});

describe("stealStaleLock", () => {
  const age = (path: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(path, t, t); };

  it("removes a stale lock and leaves no moved-aside file behind", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "dead");
    age(lock, STALE_LOCK_MS + 1000);
    expect(stealStaleLock(lock)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("puts back a live lock that replaced the stale one after the staleness check", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "dead");
    age(lock, STALE_LOCK_MS + 1000);
    // Between our check and our rename the stale holder is replaced by a live one.
    const stolen = stealStaleLock(lock, STALE_LOCK_MS, () => {
      rmSync(lock);
      writeFileSync(lock, "live");
    });
    expect(stolen).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("live");
    expect(readdirSync(dir)).toEqual(["x.lock"]);
  });

  it("puts back a live lock that took the stale one's place with the same mtime", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "dead");
    age(lock, STALE_LOCK_MS + 1000);
    const staleMtime = statSync(lock).mtime;
    // The replacement is created while the stale file still exists, so it has a different inode,
    // and carries the same mtime: only the inode check can tell it from the stale lock.
    const stolen = stealStaleLock(lock, STALE_LOCK_MS, () => {
      const replacement = join(dir, "replacement");
      writeFileSync(replacement, "live");
      utimesSync(replacement, staleMtime, staleMtime);
      renameSync(replacement, lock);
    });
    expect(stolen).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("live");
    expect(readdirSync(dir)).toEqual(["x.lock"]);
  });

  it("lets only one of several waiters steal the same stale lock", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "dead");
    age(lock, STALE_LOCK_MS + 1000);
    // The second waiter checked before the first removed the lock, and renames after it.
    let second = true;
    const first = stealStaleLock(lock, STALE_LOCK_MS, () => { second = stealStaleLock(lock); });
    expect(second).toBe(true);
    expect(first).toBe(false);
  });
});
