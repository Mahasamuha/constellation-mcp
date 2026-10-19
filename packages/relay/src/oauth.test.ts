import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    createLogger: () => ({ ...log, child: () => log }),
    generateToken: () => "generated-token",
    hashToken: (t: string) => `hashed:${t}`,
    safeEqual: (a: string, b: string) => a === b,
    requireEnv: (name: string) => (name === "RELAY_URL" ? "https://relay.example.com" : `env:${name}`),
  };
});

vi.mock("./config.js", () => ({
  config: { authMode: "oidc", secureCookies: true, oauthAllowedRedirectOrigins: [], oauthDynamicClientTtlHours: 24 },
}));

vi.mock("./db.js", () => ({
  prisma: { oauthClient: { create: vi.fn() }, authCode: { create: vi.fn() } },
}));

vi.mock("./oidc.js", () => ({
  buildAuthorizationUrl: vi.fn(),
  exchangeCodeAndUpsertUser: vi.fn(),
}));
vi.mock("./device.js", () => ({ handleDeviceCodeGrant: vi.fn() }));
vi.mock("./local-auth.js", () => ({ checkBruteForce: vi.fn(), recordFailure: vi.fn(), validateLocalUser: vi.fn() }));
vi.mock("./oauth-tokens.js", () => ({ issueOAuthSession: vi.fn(), makeTokenPair: vi.fn(), sendTokenResponse: vi.fn() }));

import { prisma } from "./db.js";
import { buildAuthorizationUrl } from "./oidc.js";
import { oauthRouter } from "./oauth.js";

const db = prisma as unknown as { oauthClient: { create: ReturnType<typeof vi.fn> } };
const buildUrl = buildAuthorizationUrl as ReturnType<typeof vi.fn>;

// Signed cookies are injected directly; cookie-parser signing is not under test here.
let signedCookies: Record<string, string> = {};
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser("test-secret"));
  app.use((req, _res, next) => {
    req.signedCookies = signedCookies;
    next();
  });
  app.use("/", oauthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  signedCookies = {};
});

function pendingCookie(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    clientId: "client-1",
    redirectUri: "https://claude.ai/cb",
    downstreamCodeChallenge: "challenge",
    downstreamCodeChallengeMethod: "S256",
    downstreamState: "st ate&1",
    csrfToken: "csrf-ok",
    ...over,
  });
}

function postConsent(form: Record<string, string>) {
  return fetch(`${base}/oauth/authorize/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

describe("POST /oauth/authorize/consent", () => {
  it("returns 400 when the pending cookie is missing", async () => {
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "approve" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the cookie is malformed", async () => {
    signedCookies["authz_pending_abc"] = "{not json";
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "approve" });
    expect(res.status).toBe(400);
  });

  it("returns 403 on a bad CSRF token", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie();
    const res = await postConsent({ pending: "abc", csrf_token: "wrong", action: "approve" });
    expect(res.status).toBe(403);
    expect(buildUrl).not.toHaveBeenCalled();
  });

  it("returns 403 when the CSRF token is absent", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie();
    const res = await postConsent({ pending: "abc", action: "approve" });
    expect(res.status).toBe(403);
  });

  it("redirects to the client with access_denied and state on deny", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie();
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "deny" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://claude.ai/cb");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st ate&1");
    expect(buildUrl).not.toHaveBeenCalled();
  });

  it("preserves an existing query on the redirect_uri when denying", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie({ redirectUri: "https://claude.ai/cb?tenant=a&x=1" });
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "deny" });
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/cb");
    expect(loc.searchParams.get("tenant")).toBe("a");
    expect(loc.searchParams.get("x")).toBe("1");
    expect(loc.searchParams.get("error")).toBe("access_denied");
  });

  it("omits state on deny when none was supplied", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie({ downstreamState: undefined });
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "deny" });
    expect(new URL(res.headers.get("location")!).searchParams.has("state")).toBe(false);
  });

  it("redirects to the upstream provider on approve", async () => {
    buildUrl.mockResolvedValue({
      url: new URL("https://idp.example.com/authorize?client_id=x"),
      state: "up-state",
      codeVerifier: "verifier",
    });
    signedCookies["authz_pending_abc"] = pendingCookie();
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "approve" });
    expect(res.status).toBe(302);
    expect(buildUrl).toHaveBeenCalledWith("https://relay.example.com/oauth/callback", true);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://idp.example.com");
    expect(loc.searchParams.get("state")).toMatch(/^up-state:[0-9a-f]{32}$/);
    expect(res.headers.get("set-cookie")).toMatch(/oidc_pending_[0-9a-f]{32}=/);
  });
});

describe("POST /oauth/register", () => {
  it("defaults grant_types to authorization_code and refresh_token", async () => {
    db.oauthClient.create.mockResolvedValue({ id: "cid", createdAt: new Date(0) });
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3000/cb"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant_types: string[] };
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(db.oauthClient.create.mock.calls[0]![0].data.grantTypes).toEqual(["authorization_code", "refresh_token"]);
  });
});
