import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => `hashed:${t}`,
    generateToken: () => "generated-token",
    requireEnv: (name: string) => `env:${name}`,
  };
});

vi.mock("./config.js", () => ({
  config: {
    adminSessionDurationMs: 3600_000,
    secureCookies: true,
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    deviceCode: { findUnique: vi.fn(), delete: vi.fn() },
    oauthSession: { findFirst: vi.fn(), update: vi.fn() },
    executor: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    executorToken: { update: vi.fn(), create: vi.fn() },
    oauthClient: { upsert: vi.fn() },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx())),
  },
}));

vi.mock("./oauth-tokens.js", () => ({
  issueOAuthSession: vi.fn().mockResolvedValue({ accessToken: "access", expiresInSec: 3600 }),
  sendTokenResponse: vi.fn((res: { json: (b: unknown) => void }, tokens: unknown) => res.json({ ok: true, tokens })),
}));

import { prisma } from "./db.js";
import { issueOAuthSession, sendTokenResponse } from "./oauth-tokens.js";
import { handleDeviceCodeGrant } from "./device.js";

function mockTx() {
  return prisma as unknown as {
    executor: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    executorToken: { update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  };
}

const db = prisma as unknown as {
  deviceCode: { findUnique: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  oauthSession: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  executor: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  executorToken: { update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    end() { return this; },
  };
  return res;
}

const FUTURE = new Date(Date.now() + 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  db.executorToken.create.mockResolvedValue({ id: "token-1" });
});

describe("handleDeviceCodeGrant — scope dispatch", () => {
  it("agent:escalate elevates the target session and returns 204 when it's still valid", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      deviceCodeHash: "h", expiresAt: FUTURE, status: "approved", userId: "user-1",
      scope: "agent:escalate", elevateSessionId: "sess-1", hostName: null,
    });
    db.oauthSession.findFirst.mockResolvedValue({ id: "sess-1", expiresAt: FUTURE });

    const res = mockRes();
    await handleDeviceCodeGrant({ device_code: "dc" }, res as never);

    expect(db.oauthSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { adminUntil: expect.any(Date) },
    });
    expect(res.statusCode).toBe(204);
  });

  it("agent:escalate returns access_denied when the target session is gone", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      deviceCodeHash: "h", expiresAt: FUTURE, status: "approved", userId: "user-1",
      scope: "agent:escalate", elevateSessionId: "sess-1", hostName: null,
    });
    db.oauthSession.findFirst.mockResolvedValue(null);

    const res = mockRes();
    await handleDeviceCodeGrant({ device_code: "dc" }, res as never);

    expect(db.oauthSession.update).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: "access_denied" });
  });

  it("agent:register:shared creates a HUB-typed executor token", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      deviceCodeHash: "h", expiresAt: FUTURE, status: "approved", userId: "approver-1",
      scope: "agent:register:shared", elevateSessionId: null, hostName: "shared-host",
    });
    db.executor.findFirst.mockResolvedValue(null);

    const res = mockRes();
    await handleDeviceCodeGrant({ device_code: "dc" }, res as never);

    expect(db.executorToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: null, tokenType: "HUB", approvedByUserId: "approver-1" }),
    }));
    expect(res.body).toMatchObject({ token_type: "agent", host: "shared-host" });
  });

  it("agent:register creates a user-bound executor token", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      deviceCodeHash: "h", expiresAt: FUTURE, status: "approved", userId: "user-1",
      scope: "agent:register", elevateSessionId: null, hostName: "my-host",
    });
    db.executor.findFirst.mockResolvedValue(null);

    const res = mockRes();
    await handleDeviceCodeGrant({ device_code: "dc" }, res as never);

    expect(db.executorToken.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-1" }),
    }));
    expect(res.body).toMatchObject({ token_type: "agent", host: "my-host" });
  });

  it("relay:manage issues a standard OAuth session", async () => {
    db.deviceCode.findUnique.mockResolvedValue({
      deviceCodeHash: "h", expiresAt: FUTURE, status: "approved", userId: "user-1",
      scope: "relay:manage", elevateSessionId: null, hostName: null,
    });

    const res = mockRes();
    await handleDeviceCodeGrant({ device_code: "dc" }, res as never);

    expect(issueOAuthSession).toHaveBeenCalledWith("user-1", "constellation-cli");
    expect(sendTokenResponse).toHaveBeenCalled();
  });
});
