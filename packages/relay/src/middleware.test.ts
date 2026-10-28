import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

vi.mock("./db.js", () => ({
  prisma: { user: { upsert: vi.fn() } },
}));

import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TokenValidationError, type Principal, type Verifier } from "@mahasamuha/asterism-verify";
import { prisma } from "./db.js";
import { requireBearerAuth, requireAdmin, requireCliClient, setVerifierForTests, type AuthenticatedRequest } from "./middleware.js";

const RELAY = "https://relay.example.com";
const CHALLENGE = `Bearer realm="${RELAY}/mcp", resource_metadata="${RELAY}/.well-known/oauth-protected-resource/mcp"`;
const upsert = prisma.user.upsert as unknown as ReturnType<typeof vi.fn>;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    subject: "user-1",
    clientId: "client-1",
    scopes: ["relay"],
    expiresAt: new Date(Date.now() + 60_000),
    claims: { groups: ["staff"], email: "a@example.com" },
    ...over,
  };
}

let verify: ReturnType<typeof vi.fn>;
let server: Server;
let base: string;
const prevRelayUrl = process.env["RELAY_URL"];

beforeAll(async () => {
  process.env["RELAY_URL"] = RELAY;
  const app = express();
  app.get("/me", requireBearerAuth, (req, res) => {
    res.json({ user: (req as AuthenticatedRequest).user });
  });
  app.get("/admin", requireBearerAuth, requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/cli-only", requireBearerAuth, requireCliClient, (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/admin-alone", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
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
  verify = vi.fn();
  setVerifierForTests({ verify } as unknown as Verifier);
  upsert.mockReset().mockResolvedValue({ id: "user-1" });
});

afterEach(() => {
  setVerifierForTests(null);
});

const get = (path: string, token: string | null = "tok") =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("requireBearerAuth", () => {
  it("sets req.user from the verified principal", async () => {
    verify.mockResolvedValue(principal());
    const res = await get("/me");
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("tok");
    expect(await res.json()).toEqual({
      user: {
        id: "user-1",
        clientId: "client-1",
        scopes: ["relay"],
        groups: ["staff"],
        claims: { groups: ["staff"], email: "a@example.com" },
      },
    });
  });

  it("answers 401 with a resource_metadata challenge when there is no bearer token", async () => {
    const res = await get("/me", null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 401 invalid_token with the challenge when verification fails", async () => {
    verify.mockRejectedValue(new TokenValidationError("invalid_audience", "bad aud"));
    const res = await get("/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${CHALLENGE}, error="invalid_token"`);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("answers 503 with Retry-After and no challenge on jwks_unavailable", async () => {
    verify.mockRejectedValue(new TokenValidationError("jwks_unavailable", "down"));
    const res = await get("/me");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("answers 403 insufficient_scope naming relay when the token lacks it", async () => {
    verify.mockResolvedValue(principal({ scopes: ["other"] }));
    const res = await get("/me");
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="relay"');
    expect(header).toContain("resource_metadata=");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("answers 403 invalid_token_claims, with no challenge, for a malformed groups claim", async () => {
    verify.mockResolvedValue(principal({ claims: { groups: "constellation-admins" } }));
    const res = await get("/me");
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toMatchObject({ error: "invalid_token_claims" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("answers 500 when the users upsert fails", async () => {
    verify.mockResolvedValue(principal());
    upsert.mockRejectedValue(new Error("db down"));
    const res = await get("/me");
    expect(res.status).toBe(500);
  });
});

describe("users row", () => {
  it("upserts a bare row for the sub", async () => {
    verify.mockResolvedValue(principal());
    await get("/me");
    expect(upsert).toHaveBeenCalledWith({ where: { id: "user-1" }, create: { id: "user-1" }, update: {} });
  });

  it("upserts once per known sub, and again for a new one", async () => {
    verify.mockResolvedValue(principal());
    await get("/me");
    await get("/me");
    await get("/me");
    expect(upsert).toHaveBeenCalledTimes(1);
    verify.mockResolvedValue(principal({ subject: "user-2" }));
    await get("/me");
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("does not cache a sub whose upsert failed", async () => {
    verify.mockResolvedValue(principal());
    upsert.mockRejectedValueOnce(new Error("db down"));
    await get("/me");
    await get("/me");
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe("requireAdmin", () => {
  it("passes when the token carries the admin scope and the admin group", async () => {
    verify.mockResolvedValue(principal({ scopes: ["relay", "admin"], claims: { groups: ["constellation-admins"] } }));
    const res = await get("/admin");
    expect(res.status).toBe(200);
  });

  it("answers 403 asking for relay and admin when admin is missing", async () => {
    verify.mockResolvedValue(principal());
    const res = await get("/admin");
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="relay admin"');
  });

  it("answers a plain 403 with no step-up challenge when the admin scope lacks the admin group", async () => {
    verify.mockResolvedValue(principal({ scopes: ["relay", "admin"], claims: { groups: ["staff"] } }));
    const res = await get("/admin");
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toMatchObject({ error_description: expect.stringContaining("not in the admin group") });
  });

  it("denies the admin scope with no groups claim at all", async () => {
    verify.mockResolvedValue(principal({ scopes: ["relay", "admin"], claims: {} }));
    expect((await get("/admin")).status).toBe(403);
  });

  it("does not authorize by the groups claim", async () => {
    verify.mockResolvedValue(principal({ claims: { groups: ["constellation-admins"] } }));
    const res = await get("/admin");
    expect(res.status).toBe(403);
  });

  it("fails closed with 401 when run without requireBearerAuth", async () => {
    const res = await get("/admin-alone");
    expect(res.status).toBe(401);
  });
});

describe("requireCliClient", () => {
  it("accepts a token issued to the CLI client", async () => {
    verify.mockResolvedValue(principal({ clientId: `${RELAY}/clients/cli.json` }));
    const res = await fetch(`${base}/cli-only`, { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
  });

  it("refuses a token issued to an MCP client or to another Constellation client with 403 invalid_client", async () => {
    for (const clientId of ["https://claude.ai/oauth/client.json", `${RELAY}/clients/node.json`, `${RELAY}/clients/hub.json`]) {
      verify.mockResolvedValue(principal({ clientId }));
      const res = await fetch(`${base}/cli-only`, { headers: { Authorization: "Bearer t" } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_client");
    }
  });
});
