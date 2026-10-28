import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    HOST_NAME_PATTERN: actual.HOST_NAME_PATTERN,
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => `hashed:${t}`,
    generateToken: () => "generated-token",
    requireEnv: () => "https://relay.example.com",
    clientIdFor: (relay: string, kind: string) => `${relay}/clients/${kind}.json`,
  };
});

vi.mock("./registry.js", () => ({ getConnection: vi.fn() }));
vi.mock("./hub.js", () => ({ cancelPendingRotation: vi.fn().mockResolvedValue(undefined) }));

vi.mock("./middleware.js", () => ({
  requireBearerAuth: vi.fn(),
  // Mirrors B2's contract: 403 insufficient_scope unless the token carries admin.
  requireAdmin: vi.fn((req: { user: { scopes: string[] } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (req.user.scopes.includes("admin")) next();
    else res.status(403).json({ error: "insufficient_scope" });
  }),
  sendMissingScopes: vi.fn((res: { status: (n: number) => { json: (b: unknown) => void } }, scopes: string[]) => {
    res.status(403).json({ error: "insufficient_scope", scope: scopes.join(" ") });
  }),
}));

vi.mock("./db.js", () => {
  const tx = {
    user: { upsert: vi.fn() },
    executor: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    executorToken: { update: vi.fn(), create: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)) } };
});

import { prisma } from "./db.js";
import { registerExecutor } from "./executors.js";
import { getConnection } from "./registry.js";
import { cancelPendingRotation } from "./hub.js";
import { Prisma } from "./generated/prisma/client.js";

const getConn = getConnection as unknown as ReturnType<typeof vi.fn>;
const NODE_CLIENT = "https://relay.example.com/clients/node.json";
const HUB_CLIENT = "https://relay.example.com/clients/hub.json";

const db = prisma as unknown as {
  user: { upsert: ReturnType<typeof vi.fn> };
  executor: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  executorToken: { update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    set() { return this; },
  };
}

function mockReq(body: unknown, scopes: string[], clientId: string) {
  return { body, user: { id: "user-1", clientId, scopes, groups: [], claims: {} } };
}

// The client defaults to the one registering that type, so tests only name it when it's wrong.
async function register(body: unknown, scopes?: string[], clientId?: string) {
  const res = mockRes();
  const type = (body as { type?: string } | undefined)?.type;
  const client = clientId ?? (type === "hub" ? HUB_CLIENT : NODE_CLIENT);
  await registerExecutor(mockReq(body, scopes ?? ["relay", "register"], client) as never, res as never);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.executorToken.create.mockResolvedValue({ id: "token-new" });
});

describe("POST /api/executors/register", () => {
  it("rejects an unknown type", async () => {
    const res = await register({ type: "agent", host: "h" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
  });

  it("rejects a missing, blank or over-long host", async () => {
    expect((await register({ type: "node" })).statusCode).toBe(400);
    expect((await register({ type: "node", host: "   " })).statusCode).toBe(400);
    expect((await register({ type: "node", host: "x".repeat(64) })).statusCode).toBe(400);
    expect((await register({ type: "node", host: 5 })).statusCode).toBe(400);
    expect(db.executorToken.create).not.toHaveBeenCalled();
  });

  it("accepts a 63-character host and trims it", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    const res = await register({ type: "node", host: ` ${"x".repeat(63)} ` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ host: "x".repeat(63) });
  });

  it("creates a node executor owned by the caller and returns the token", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    const res = await register({ type: "node", host: "laptop" });

    expect(db.executor.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1", host: "laptop" } }));
    expect(db.executorToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: "user-1", tokenHash: "hashed:generated-token" } })
    );
    expect(db.executor.create).toHaveBeenCalledWith({ data: { userId: "user-1", executorTokenId: "token-new", host: "laptop" } });
    expect(res.body).toEqual({ access_token: "generated-token", token_type: "agent", host: "laptop" });
  });

  it("revokes the old token and repoints the executor when a node re-registers its host", async () => {
    db.executor.findFirst.mockResolvedValue({ id: "exec-1", executorTokenId: "token-old" });
    const res = await register({ type: "node", host: "laptop" });

    expect(db.executorToken.update).toHaveBeenCalledWith({ where: { id: "token-old" }, data: { revokedAt: expect.any(Date) } });
    expect(db.executor.update).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: { executorTokenId: "token-new", lastHeartbeatAt: null, lastDisconnectReason: null },
    });
    expect(db.executor.create).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("refuses a hub registration without the admin scope", async () => {
    const res = await register({ type: "hub", host: "hub-1" }, ["relay", "register"]);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "insufficient_scope", scope: "relay admin register" });
    expect(db.executorToken.create).not.toHaveBeenCalled();
  });

  it("creates a shared HUB token recording the approving admin", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    const res = await register({ type: "hub", host: "hub-1" }, ["relay", "admin", "register"]);

    expect(db.executorToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: null, tokenType: "HUB", tokenHash: "hashed:generated-token", approvedByUserId: "user-1" } })
    );
    expect(db.executor.create).toHaveBeenCalledWith({ data: { userId: null, executorTokenId: "token-new", host: "hub-1" } });
    expect(res.body).toEqual({ access_token: "generated-token", token_type: "agent", host: "hub-1" });
  });

  it("revokes the active HUB token for the host and replaces it", async () => {
    db.executor.findFirst.mockResolvedValue({ id: "exec-h", executorTokenId: "token-old-hub" });
    await register({ type: "hub", host: "hub-1" }, ["relay", "admin", "register"]);

    expect(db.executor.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: null, host: "hub-1", executorToken: { tokenType: "HUB" } },
    }));
    expect(db.executorToken.update).toHaveBeenCalledWith({ where: { id: "token-old-hub" }, data: { revokedAt: expect.any(Date) } });
    expect(db.executor.update).toHaveBeenCalledWith({
      where: { id: "exec-h" },
      data: { executorTokenId: "token-new", lastHeartbeatAt: null, lastDisconnectReason: null },
    });
  });

  it("refuses a node registration from a token issued to another client", async () => {
    for (const clientId of ["https://claude.ai/oauth/client.json", HUB_CLIENT, "https://relay.example.com/clients/cli.json"]) {
      const res = await register({ type: "node", host: "laptop" }, ["relay", "register"], clientId);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ error: "invalid_client" });
    }
    expect(db.executorToken.create).not.toHaveBeenCalled();
  });

  it("refuses a registration without the fresh-approval register scope, asking for it", async () => {
    const res = await register({ type: "node", host: "laptop" }, ["relay"]);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "insufficient_scope", scope: "relay register" });
    expect(db.executorToken.create).not.toHaveBeenCalled();
    const hub = await register({ type: "hub", host: "hub-1" }, ["relay", "admin"]);
    expect(hub.statusCode).toBe(403);
    expect(hub.body).toMatchObject({ scope: "relay admin register" });
  });

  it("cancels a pending rotation for an executor whose token was replaced", async () => {
    db.executor.findFirst.mockResolvedValue({ id: "exec-1", executorTokenId: "token-old" });
    await register({ type: "node", host: "laptop" });
    expect(cancelPendingRotation).toHaveBeenCalledWith("exec-1");
  });

  it("refuses a hub registration from the node client, even with the admin scope", async () => {
    const res = await register({ type: "hub", host: "hub-1" }, ["relay", "admin", "register"], NODE_CLIENT);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "invalid_client" });
    expect(db.executorToken.create).not.toHaveBeenCalled();
  });

  it("rejects host names outside letters, digits, dot, underscore and hyphen", async () => {
    for (const host of ["my laptop", "a/b", "<script>"]) {
      expect((await register({ type: "node", host })).statusCode).toBe(400);
    }
    expect(db.executorToken.create).not.toHaveBeenCalled();
  });

  it("takes a per-(owner, host) advisory lock before looking the executor up", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    await register({ type: "node", host: "laptop" });
    await register({ type: "hub", host: "hub-1" }, ["relay", "admin", "register"]);
    const tx = db as unknown as { $executeRaw: ReturnType<typeof vi.fn> };
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const keys = tx.$executeRaw.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(["user-1:laptop", "hub:hub-1"]);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(db.executor.findFirst.mock.invocationCallOrder[0]!);
  });

  it("answers 409 on a unique violation instead of 500", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    db.executor.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );
    const res = await register({ type: "node", host: "laptop" });
    expect(res.statusCode).toBe(409);
  });

  it("terminates the live connection of an executor whose token was replaced", async () => {
    const terminate = vi.fn();
    getConn.mockReturnValue({ ws: { terminate } });
    db.executor.findFirst.mockResolvedValue({ id: "exec-1", executorTokenId: "token-old" });
    await register({ type: "node", host: "laptop" });
    expect(getConn).toHaveBeenCalledWith("exec-1");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("does not look for a connection on a first registration", async () => {
    db.executor.findFirst.mockResolvedValue(null);
    await register({ type: "node", host: "laptop" });
    expect(getConn).not.toHaveBeenCalled();
  });
});
