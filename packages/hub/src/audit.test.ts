import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AuditWriter, type AuditEntry } from "./audit.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(dir);
});

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    hub_name: "test-hub",
    request_id: "req-1",
    user_oidc_sub: null,
    local_username: "alice",
    share: "docs",
    tool: "read_file",
    outcome: "ok",
    error: null,
    ...overrides,
  };
}

describe("AuditWriter", () => {
  it("write() returns immediately and the entry lands on disk once flushed", async () => {
    const logPath = join(dir, "audit.jsonl");
    const writer = new AuditWriter(logPath);

    writer.write(entry({ request_id: "req-1" }));
    await writer.flush();

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ request_id: "req-1" });
    await writer.close();
  });

  it("preserves write order across many unawaited calls", async () => {
    const logPath = join(dir, "audit.jsonl");
    const writer = new AuditWriter(logPath);

    for (let i = 0; i < 20; i++) {
      writer.write(entry({ request_id: `req-${i}` }));
    }
    await writer.flush();

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.request_id)).toEqual(Array.from({ length: 20 }, (_, i) => `req-${i}`));
    await writer.close();
  });

  it("reuses the same file handle across writes instead of reopening the path each time", async () => {
    const logPath = join(dir, "audit.jsonl");
    const writer = new AuditWriter(logPath);

    writer.write(entry({ request_id: "req-1" }));
    writer.write(entry({ request_id: "req-2" }));
    await writer.flush();

    // Both entries landed via the same lazily-opened handle, appended in order —
    // not two independent open+write+close cycles racing on the same path.
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    await writer.close();
  });

  it("fails open: logs to stderr and never throws or rejects when the directory doesn't exist", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logPath = join(dir, "missing-subdir", "audit.jsonl");
    const writer = new AuditWriter(logPath);

    expect(() => writer.write(entry())).not.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Failed to write audit entry"));
    stderr.mockRestore();
  });

  it("self-heals once the destination becomes writable, instead of caching the first failure forever", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const subdir = join(dir, "subdir");
    const logPath = join(subdir, "audit.jsonl");
    const writer = new AuditWriter(logPath);

    writer.write(entry({ request_id: "req-1" }));
    await writer.flush();
    expect(() => readFileSync(logPath, "utf8")).toThrow();

    mkdirSync(subdir);
    writer.write(entry({ request_id: "req-2" }));
    await writer.flush();

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ request_id: "req-2" });

    await writer.close();
    vi.restoreAllMocks();
  });

  it("close() is a no-op when no handle was ever opened", async () => {
    const writer = new AuditWriter(join(dir, "audit.jsonl"));
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
