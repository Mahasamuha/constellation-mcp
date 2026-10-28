import { vi, describe, it, expect, beforeEach } from "vitest";
import { WebSocket } from "ws";

vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    HOST_NAME_PATTERN: actual.HOST_NAME_PATTERN,
    EXECUTOR_TOKEN_PATTERN: actual.EXECUTOR_TOKEN_PATTERN,
    SHARE_NAME_PATTERN: actual.SHARE_NAME_PATTERN,
    sanitizeMultilineText: actual.sanitizeMultilineText,
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => `hashed:${t}`,
    generateToken: () => "ab".repeat(32),
  };
});

vi.mock("./config.js", () => ({
  config: {
    rateLimits: { wsReconnectPerMin: 10 },
    heartbeat: { intervalMs: 60_000, maxMissed: 3 },
    ws: { maxMessageBytes: 10_485_760 },
    rpcTimeoutMs: 30_000,
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    executor: { update: vi.fn() },
    executorToken: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("./activity.js", () => ({ logEvent: vi.fn() }));

vi.mock("./registry.js", () => ({
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  getConnection: vi.fn(),
  allConnections: vi.fn().mockReturnValue([]),
  dispatchPendingRpc: vi.fn(),
  resolvePendingRpc: vi.fn(),
  rejectPendingRpcsForExecutor: vi.fn(),
}));

import { prisma } from "./db.js";
import { handleUpdateHost, handleHubShareSync, handleConfigUpdate, handleRotateToken, cancelPendingRotation, pruneExpiredOrphanedTokens } from "./hub.js";
import { sanitizeMultilineText } from "@constellation/shared";
import type { ConnectedExecutor } from "./registry.js";

const db = prisma as unknown as {
  executor: { update: ReturnType<typeof vi.fn> };
  executorToken: Record<"create" | "update" | "updateMany" | "deleteMany", ReturnType<typeof vi.fn>>;
  $transaction: ReturnType<typeof vi.fn>;
};

function mockConn(overrides: Partial<ConnectedExecutor> = {}): { conn: ConnectedExecutor; sent: unknown[] } {
  const sent: unknown[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data)),
  } as unknown as ConnectedExecutor["ws"];
  const conn: ConnectedExecutor = {
    ws,
    executorId: "exec-1",
    userId: "user-1",
    tokenType: "NODE" as ConnectedExecutor["tokenType"],
    host: "old-host",
    tokenId: "token-1",
    lastPongAt: Date.now(),
    missedPings: 0,
    ...overrides,
  };
  return { conn, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleUpdateHost", () => {
  it("updates the host directly, with no pre-check, when the write succeeds", async () => {
    db.executor.update.mockResolvedValue({});
    const { conn, sent } = mockConn();

    await handleUpdateHost(conn, { type: "update_host", host: "new-host" });

    expect(db.executor.update).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: { host: "new-host" },
    });
    expect(conn.host).toBe("new-host");
    expect(sent).toEqual([{ type: "update_host_ok", host: "new-host" }]);
  });

  it("reports a conflict when the write violates the (user_id, host) unique index, without a separate read", async () => {
    const { Prisma } = await import("./generated/prisma/client.js");
    db.executor.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );
    const { conn, sent } = mockConn();

    await handleUpdateHost(conn, { type: "update_host", host: "taken-host" });

    expect(conn.host).toBe("old-host"); // unchanged on failure
    expect(sent).toEqual([
      { type: "update_host_error", error: 'Host name "taken-host" is already registered' },
    ]);
  });

  it("rejects a host name outside the shared rule without writing", async () => {
    const { conn, sent } = mockConn();

    await handleUpdateHost(conn, { type: "update_host", host: "my laptop" });

    expect(db.executor.update).not.toHaveBeenCalled();
    expect(conn.host).toBe("old-host");
    expect(sent).toEqual([expect.objectContaining({ type: "update_host_error" })]);
  });

  it("rethrows an unrelated database error instead of treating it as a naming conflict", async () => {
    db.executor.update.mockRejectedValue(new Error("connection lost"));
    const { conn } = mockConn();

    await expect(handleUpdateHost(conn, { type: "update_host", host: "new-host" })).rejects.toThrow(
      "connection lost"
    );
  });

  it("rejects hub connections — hubs use a fixed host", async () => {
    const { conn, sent } = mockConn({ tokenType: "HUB" as ConnectedExecutor["tokenType"] });

    await handleUpdateHost(conn, { type: "update_host", host: "new-host" });

    expect(db.executor.update).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: "update_host_error", error: "Hubs use a fixed host (machine ID); update_host is not supported" },
    ]);
  });
});

describe("hub_share_sync override validation", () => {
  const share = (overrides: unknown[]) => ({
    name: "docs",
    reported_path: "/srv/docs",
    permission_blob: { default: "none", overrides },
  });
  const sync = async (overrides: unknown[]) => {
    const { conn, sent } = mockConn({ tokenType: "HUB" as ConnectedExecutor["tokenType"] });
    await handleHubShareSync(conn, { type: "hub_share_sync", shares: [share(overrides)] });
    return sent[0] as { type: string; error?: string };
  };

  beforeEach(() => {
    db.$transaction.mockResolvedValue(undefined);
  });

  it("accepts sub and group overrides", async () => {
    const reply = await sync([{ sub: "u-1", access: "read-write" }, { group: "eng", access: "read-only" }]);
    expect(reply.type).toBe("hub_share_sync_ok");
  });

  it("rejects a legacy oidc_sub entry with a message to re-key it", async () => {
    const reply = await sync([{ oidc_sub: "abc", access: "read-only" }]);
    expect(reply.type).toBe("hub_share_sync_error");
    expect(reply.error).toContain("oidc_sub");
    expect(reply.error).toMatch(/re-key.*sub.*group/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["both sub and group", { sub: "u", group: "g", access: "none" }],
    ["neither", { access: "none" }],
    ["an empty sub", { sub: "", access: "none" }],
    ["an empty group", { group: "", access: "none" }],
    ["a non-string group", { group: 5, access: "none" }],
    ["an invalid access", { sub: "u", access: "admin" }],
    ["a missing access", { sub: "u" }],
    ["a non-object entry", "nope"],
  ])("rejects %s", async (_label, entry) => {
    const reply = await sync([entry]);
    expect(reply.type).toBe("hub_share_sync_error");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("share name and instructions validation", () => {
  const syncOne = async (name: unknown, instructions?: unknown) => {
    const { conn, sent } = mockConn({ tokenType: "HUB" as ConnectedExecutor["tokenType"] });
    await handleHubShareSync(conn, {
      type: "hub_share_sync",
      shares: [{ name, reported_path: "/srv", permission_blob: { default: "none" }, instructions }],
    });
    return sent[0] as { type: string; error?: string };
  };

  beforeEach(() => {
    db.$transaction.mockResolvedValue(undefined);
  });

  it.each(["has space", "a/b", "x\u202Ey", "new\nline", "a".repeat(65), "<b>"])("hub_share_sync rejects share name %j", async (name) => {
    const reply = await syncOne(name);
    expect(reply.type).toBe("hub_share_sync_error");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("hub_share_sync accepts a plain share name", async () => {
    expect((await syncOne("docs-2.v_1")).type).toBe("hub_share_sync_ok");
  });

  it("hub_share_sync caps the number of shares", async () => {
    const { conn, sent } = mockConn({ tokenType: "HUB" as ConnectedExecutor["tokenType"] });
    const shares = Array.from({ length: 1001 }, (_, i) => ({ name: `s${i}`, reported_path: "/x", permission_blob: { default: "none" } }));
    await handleHubShareSync(conn, { type: "hub_share_sync", shares });
    expect((sent[0] as { type: string }).type).toBe("hub_share_sync_error");
  });

  it("hub_share_sync stores sanitized instructions", async () => {
    const upsert = vi.fn();
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ hubShare: { upsert, deleteMany: vi.fn() } }));
    await syncOne("docs", "ok\u202Eevil\u200Bhidden\u0007\nline2");
    expect(upsert.mock.calls[0][0].create.instructions).toBe("okevilhidden\nline2");
  });

  it("sanitizeMultilineText strips control, bidi and zero-width characters but keeps newlines", () => {
    expect(sanitizeMultilineText("a\u0000b\u001bc\u2066d\ufeffe\u2028f\tg\nh")).toBe("abcdef\tg\nh");
  });

  describe("config_update", () => {
    const update = async (paths: unknown) => {
      const { conn, sent } = mockConn();
      await handleConfigUpdate(conn, { type: "config_update", paths });
      return sent[0] as { type: string; error?: string };
    };

    it.each(["bad name", "a\u202Eb", "x".repeat(65), 5])("rejects share %j", async (share) => {
      const reply = await update([{ share, reported_path: "/p" }]);
      expect(reply.type).toBe("config_update_error");
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects oversize instructions and non-string instructions", async () => {
      expect((await update([{ share: "a", reported_path: "/p", instructions: "x".repeat(4097) }])).type).toBe("config_update_error");
      expect((await update([{ share: "a", reported_path: "/p", instructions: 5 }])).type).toBe("config_update_error");
    });

    it("rejects more entries than the cap", async () => {
      const paths = Array.from({ length: 257 }, (_, i) => ({ share: `s${i}`, reported_path: "/p" }));
      const reply = await update(paths);
      expect(reply.type).toBe("config_update_error");
      expect(reply.error).toContain("at most");
    });

    it("stores sanitized instructions", async () => {
      const upsert = vi.fn();
      db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
        fn({ pathShare: { findFirst: vi.fn().mockResolvedValue(null), upsert, deleteMany: vi.fn() } }));
      const reply = await update([{ share: "a", reported_path: "/p", instructions: "hi\u202Ethere" }]);
      expect(reply.type).toBe("config_update_ok");
      expect(upsert.mock.calls[0][0].create.instructions).toBe("hithere");
    });
  });
});

describe("token rotation", () => {
  beforeEach(() => {
    db.executorToken.create.mockResolvedValue({ id: "new-tok" });
    db.executorToken.updateMany.mockResolvedValue({ count: 1 });
    db.executorToken.update.mockResolvedValue({});
  });

  it("sends only the freshly generated token, in the executor token format", async () => {
    const { conn, sent } = mockConn({ executorId: "rot-1" });
    await handleRotateToken(conn);
    const msg = sent[0] as { type: string; token: string };
    expect(msg.type).toBe("token_rotated");
    expect(msg.token).toMatch(/^[0-9a-f]{64}$/);
    await cancelPendingRotation("rot-1");
  });

  it("allows one rotate_token per executor per minute", async () => {
    const { conn, sent } = mockConn({ executorId: "rot-2" });
    await handleRotateToken(conn);
    await handleRotateToken(conn);
    expect((sent[0] as { type: string }).type).toBe("token_rotated");
    expect((sent[1] as { type: string }).type).toBe("rotate_token_error");
    expect(db.executorToken.create).toHaveBeenCalledTimes(1);
    await cancelPendingRotation("rot-2");
  });

  it("cancelPendingRotation revokes the pending rotation token and is a no-op without one", async () => {
    const { conn } = mockConn({ executorId: "rot-3" });
    await handleRotateToken(conn);
    db.executorToken.updateMany.mockClear();
    await cancelPendingRotation("rot-3");
    expect(db.executorToken.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["new-tok"] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    db.executorToken.updateMany.mockClear();
    await cancelPendingRotation("rot-3");
    expect(db.executorToken.updateMany).not.toHaveBeenCalled();
  });
});

describe("pruneExpiredOrphanedTokens", () => {
  it("deletes revoked tokens no executor references, after the retention period", async () => {
    db.executorToken.updateMany.mockResolvedValue({ count: 0 });
    db.executorToken.deleteMany.mockResolvedValue({ count: 2 });
    await pruneExpiredOrphanedTokens();
    const where = db.executorToken.deleteMany.mock.calls[0][0].where;
    expect(where.executors).toEqual({ none: {} });
    expect(where.revokedAt.lt.getTime()).toBeLessThan(Date.now() - 59 * 60 * 1000);
  });
});
