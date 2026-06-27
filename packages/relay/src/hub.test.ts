import { vi, describe, it, expect, beforeEach } from "vitest";
import { WebSocket } from "ws";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => `hashed:${t}`,
    generateToken: () => "generated-token",
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
import { handleUpdateHost } from "./hub.js";
import type { ConnectedExecutor } from "./registry.js";

const db = prisma as unknown as { executor: { update: ReturnType<typeof vi.fn> } };

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
