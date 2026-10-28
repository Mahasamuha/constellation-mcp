import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
    generateToken: () => "cd".repeat(32),
  };
});

vi.mock("./config.js", () => ({
  config: {
    rateLimits: { wsReconnectPerMin: 1000 },
    heartbeat: { intervalMs: 60_000, maxMissed: 3 },
    ws: { maxMessageBytes: 1024 },
    rpcTimeoutMs: 30_000,
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    executor: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    executorToken: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), create: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("./activity.js", () => ({ logEvent: vi.fn() }));

vi.mock("./registry.js", () => ({
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn().mockReturnValue(true),
  getConnection: vi.fn(),
  allConnections: vi.fn().mockReturnValue([]),
  dispatchPendingRpc: vi.fn(),
  resolvePendingRpc: vi.fn(),
  rejectPendingRpcsForExecutor: vi.fn(),
}));

import { prisma } from "./db.js";
import { attachHub, closeHub } from "./hub.js";

const db = prisma as unknown as {
  executor: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
  executorToken: Record<"findUnique" | "update" | "create" | "updateMany", ReturnType<typeof vi.fn>>;
  $transaction: ReturnType<typeof vi.fn>;
};

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer();
  attachHub(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeHub();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  vi.clearAllMocks();
  db.executor.update.mockResolvedValue({});
  db.executorToken.update.mockResolvedValue({});
  db.$transaction.mockResolvedValue([]);
});

function liveToken(id = "tok-1") {
  return {
    id,
    tokenType: "NODE",
    revokedAt: null,
    expiresAt: null,
    executors: [{ id: "exec-1", userId: "user-1", host: "h" }],
  };
}

function connect(token = "t", ip?: string): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/executor/connect`, {
      headers: { authorization: `Bearer ${token}`, ...(ip ? { "x-forwarded-for": ip } : {}) },
    });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.on("error", () => {});
  });
}

const closed = (ws: WebSocket) => new Promise<number>((r) => ws.on("close", (code) => r(code)));

describe("executor upgrade", () => {
  it("replies 500 and destroys the socket when the handler throws, without an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    db.executorToken.findUnique.mockRejectedValue(new Error("db down"));
    const res = await connect("t", "9.9.9.1");
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("limits upgrade attempts per client address before touching the database", async () => {
    db.executorToken.findUnique.mockResolvedValue(null);
    let last: number | undefined;
    for (let i = 0; i < 125; i++) last = (await connect("bad", "9.9.9.2")).status;
    expect(last).toBe(429);
    const callsBefore = db.executorToken.findUnique.mock.calls.length;
    await connect("bad", "9.9.9.2");
    expect(db.executorToken.findUnique.mock.calls.length).toBe(callsBefore);
    // another address is unaffected
    expect((await connect("bad", "9.9.9.3")).status).toBe(401);
  });

  it("closes a connection that sends a message over maxPayload", async () => {
    db.executorToken.findUnique.mockResolvedValue(liveToken());
    const { ws } = await connect("t", "9.9.9.4");
    const code = closed(ws!);
    ws!.send("x".repeat(5000));
    expect(await code).toBe(1009);
  });

  it("closes a connection that floods messages", async () => {
    db.executorToken.findUnique.mockResolvedValue(liveToken());
    const { ws } = await connect("t", "9.9.9.5");
    const code = closed(ws!);
    for (let i = 0; i < 600; i++) ws!.send("{}");
    expect(await code).toBe(1008);
  });

  it("writes last_heartbeat_at at most once per 10 s and ignores unsolicited pongs", async () => {
    db.executorToken.findUnique.mockResolvedValue(liveToken());
    const { ws } = await connect("t", "9.9.9.6");
    await new Promise((r) => setTimeout(r, 30));
    db.executor.update.mockClear();
    for (let i = 0; i < 20; i++) ws!.pong();
    await new Promise((r) => setTimeout(r, 50));
    expect(db.executor.update).not.toHaveBeenCalled();
    ws!.close();
  });

  it("makes the adopted rotation token permanent in the same transaction", async () => {
    // Complete a rotation: connect with a token no executor references yet, via a pending rotation.
    db.executorToken.findUnique.mockResolvedValueOnce(liveToken("old-tok"));
    const first = await connect("old", "9.9.9.7");
    db.executorToken.create.mockResolvedValue({ id: "new-tok" });
    db.executorToken.updateMany.mockResolvedValue({ count: 0 });
    const reply = new Promise<{ token: string }>((r) => first.ws!.on("message", (d) => r(JSON.parse(d.toString()))));
    first.ws!.send(JSON.stringify({ type: "rotate_token" }));
    await reply;
    first.ws!.close();

    db.executorToken.findUnique.mockResolvedValueOnce({
      id: "new-tok", tokenType: "NODE", revokedAt: null, expiresAt: new Date(Date.now() + 60_000), executors: [],
    });
    db.executor.findUnique.mockResolvedValue({ id: "exec-1", userId: "user-1", host: "h" });
    const second = await connect("new", "9.9.9.7");
    expect(second.ws).toBeDefined();
    const ops = db.$transaction.mock.calls[0][0] as unknown[];
    expect(ops).toHaveLength(3);
    expect(db.executorToken.update).toHaveBeenCalledWith({ where: { id: "new-tok" }, data: { expiresAt: null } });
    second.ws!.close();
  });
});
