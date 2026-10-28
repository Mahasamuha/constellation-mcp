import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";

vi.mock("./db.js", () => ({
  prisma: {
    user: { upsert: vi.fn() },
    executor: { findFirst: vi.fn() },
    executorToken: { update: vi.fn() },
    relayPathFilter: { count: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("./hub.js", () => ({
  getConnection: vi.fn(),
  cancelPendingRotation: vi.fn().mockResolvedValue(undefined),
}));

import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Principal, Verifier } from "@mahasamuha/asterism-verify";
import { prisma } from "./db.js";
import { getConnection, cancelPendingRotation } from "./hub.js";
import { setVerifierForTests } from "./middleware.js";
import { apiRouter, MAX_FILTERS_PER_USER } from "./api.js";

const RELAY = "https://relay.example.com";
const CLI = `${RELAY}/clients/cli.json`;
const db = prisma as unknown as {
  executor: { findFirst: ReturnType<typeof vi.fn> };
  executorToken: { update: ReturnType<typeof vi.fn> };
  relayPathFilter: { count: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

let verify: ReturnType<typeof vi.fn>;
let server: Server;
let base: string;
const prevRelayUrl = process.env["RELAY_URL"];

function as(clientId: string, scopes = ["relay"]): void {
  verify.mockResolvedValue({
    subject: "user-1", clientId, scopes, expiresAt: new Date(Date.now() + 60_000), claims: {},
  } satisfies Principal);
}

function call(method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env["RELAY_URL"] = RELAY;
  const app = express();
  app.use(express.json());
  app.use(apiRouter);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  if (prevRelayUrl === undefined) delete process.env["RELAY_URL"];
  else process.env["RELAY_URL"] = prevRelayUrl;
});

beforeEach(() => {
  vi.clearAllMocks();
  verify = vi.fn();
  setVerifierForTests({ verify } as unknown as Verifier);
  vi.mocked(prisma.user.upsert).mockResolvedValue({ id: "user-1" } as never);
});

describe("/api accepts only the CLI client", () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/api/me"],
    ["GET", "/api/status"],
    ["GET", "/api/filters"],
    ["POST", "/api/filters", { pattern: "*.env", pattern_type: "glob" }],
    ["DELETE", "/api/filters/f1"],
    ["DELETE", "/api/executors/e1/token"],
    ["GET", "/api/activity"],
  ];

  it.each(routes)("%s %s refuses an MCP client's token", async (method, path, body) => {
    as("https://claude.ai/oauth/client.json");
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    expect(db.relayPathFilter.create).not.toHaveBeenCalled();
    expect(db.executorToken.update).not.toHaveBeenCalled();
  });

  it("serves the CLI client", async () => {
    as(CLI);
    expect((await call("GET", "/api/me")).status).toBe(200);
  });
});

describe("POST /api/filters", () => {
  beforeEach(() => {
    as(CLI);
    db.relayPathFilter.count.mockResolvedValue(0);
    db.relayPathFilter.create.mockResolvedValue({
      id: "f1", pattern: "*.env", patternType: "glob", scopeExecutorId: null, createdAt: new Date(),
    });
  });

  it("rejects a regex that is not valid RE2 (lookbehind) with 400", async () => {
    const res = await call("POST", "/api/filters", { pattern: "(?<=a)b", pattern_type: "regex" });
    expect(res.status).toBe(400);
    expect(db.relayPathFilter.create).not.toHaveBeenCalled();
  });

  it("rejects an unclosed glob bracket and an over-long pattern with 400", async () => {
    expect((await call("POST", "/api/filters", { pattern: "[abc", pattern_type: "glob" })).status).toBe(400);
    expect((await call("POST", "/api/filters", { pattern: "a".repeat(1001), pattern_type: "glob" })).status).toBe(400);
  });

  it("stores a valid filter", async () => {
    expect((await call("POST", "/api/filters", { pattern: "*.env", pattern_type: "glob" })).status).toBe(201);
  });

  it("refuses the 101st filter", async () => {
    db.relayPathFilter.count.mockResolvedValue(MAX_FILTERS_PER_USER);
    const res = await call("POST", "/api/filters", { pattern: "*.env", pattern_type: "glob" });
    expect(res.status).toBe(400);
    expect(db.relayPathFilter.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/tokens/shared", () => {
  it("is gone", async () => {
    as(CLI, ["relay", "admin"]);
    expect((await call("POST", "/api/tokens/shared")).status).toBe(404);
  });
});

describe("DELETE /api/executors/:id/token", () => {
  it("revokes the token, drops the connection and cancels a pending rotation", async () => {
    as(CLI);
    const terminate = vi.fn();
    vi.mocked(getConnection).mockReturnValue({ ws: { terminate } } as never);
    db.executor.findFirst.mockResolvedValue({ executorToken: { id: "tok", revokedAt: null } });
    const res = await call("DELETE", "/api/executors/e1/token");
    expect(res.status).toBe(204);
    expect(terminate).toHaveBeenCalled();
    expect(cancelPendingRotation).toHaveBeenCalledWith("e1");
  });
});
