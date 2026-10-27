import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLockFile } from "./file-lock.js";

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
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await expect(withLockFile(lock, async () => "ok")).resolves.toBe("ok");
  });

  it("gives up after the timeout when the lock stays held", async () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, String(process.pid));
    await expect(withLockFile(lock, async () => "ok", 250)).rejects.toThrow(/Timed out/);
  });
});
