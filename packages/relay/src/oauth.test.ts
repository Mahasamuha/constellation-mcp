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

const { config } = vi.hoisted(() => ({
  config: { authMode: "oidc", secureCookies: true, oauthAllowedRedirectOrigins: [] as string[], oauthDynamicClientTtlHours: 24 },
}));
vi.mock("./config.js", () => ({ config }));

vi.mock("./db.js", () => ({
  prisma: {
    oauthClient: { create: vi.fn(), findUnique: vi.fn() },
    oauthSession: { findUnique: vi.fn(), updateMany: vi.fn() },
    authCode: { create: vi.fn() },
  },
}));

// Real redirect-URI matching and disclosure logic; only the DB/network-backed lookup is stubbed.
vi.mock("./oauth-clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-clients.js")>()),
  resolveOauthClient: vi.fn(),
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
import { InvalidClientError, resolveOauthClient } from "./oauth-clients.js";
import { checkBruteForce, validateLocalUser } from "./local-auth.js";
import { makeTokenPair, sendTokenResponse } from "./oauth-tokens.js";
import { oauthRouter } from "./oauth.js";

type Mock = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  oauthClient: { create: Mock; findUnique: Mock };
  oauthSession: { findUnique: Mock; updateMany: Mock };
  authCode: { create: Mock };
};
const buildUrl = buildAuthorizationUrl as Mock;
const resolveClient = resolveOauthClient as Mock;

// Incoming signed cookies are injected directly (the middleware below overwrites
// whatever cookie-parser verified). cookieParser is still mounted because
// res.cookie({ signed: true }) needs req.secret to sign the outgoing Set-Cookie.
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
  config.authMode = "oidc";
});

/** Decodes the JSON payload of a signed Set-Cookie (`s:<json>.<sig>`, URI-encoded) by name prefix. */
function setCookiePayload(res: Response, namePrefix: string): Record<string, unknown> | undefined {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(namePrefix));
  if (!raw) return undefined;
  const value = decodeURIComponent(raw.slice(raw.indexOf("=") + 1).split(";")[0]!);
  return JSON.parse(value.slice(2, value.lastIndexOf("."))) as Record<string, unknown>;
}

function isCleared(res: Response, namePrefix: string): boolean {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(namePrefix));
  return !!raw && /Expires=Thu, 01 Jan 1970/i.test(raw);
}

const CHALLENGE = "a".repeat(43);

function client(over: Record<string, unknown> = {}) {
  return {
    id: "client-1",
    clientName: "Evil <b>Client</b>",
    isMetadataDocument: false,
    redirectUris: ["https://claude.ai/cb"],
    ...over,
  };
}

function authorize(params: Record<string, string | string[]>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) qs.append(k, x);
  return fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
}

const validAuthorize = {
  response_type: "code",
  client_id: "client-1",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "xyz",
};

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

    // The oidc_pending payload carries the downstream request but not the consent CSRF token.
    const payload = setCookiePayload(res, "oidc_pending_")!;
    expect(payload).toMatchObject({
      state: "up-state",
      codeVerifier: "verifier",
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      downstreamCodeChallenge: "challenge",
      downstreamCodeChallengeMethod: "S256",
      downstreamState: "st ate&1",
    });
    expect(payload).not.toHaveProperty("csrfToken");
    expect(isCleared(res, "authz_pending_abc=")).toBe(true);
  });

  it("returns 400 when the cookie has the wrong shape", async () => {
    signedCookies["authz_pending_abc"] = JSON.stringify({ clientId: "client-1" });
    const res = await postConsent({ pending: "abc", csrf_token: "csrf-ok", action: "approve" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body fields are not strings", async () => {
    signedCookies["authz_pending_abc"] = pendingCookie();
    const res = await fetch(`${base}/oauth/authorize/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pending: ["abc"], csrf_token: { a: 1 }, action: "approve" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /oauth/authorize", () => {
  it("renders the consent page with escaped client name, redirect host, and a matching CSRF cookie", async () => {
    resolveClient.mockResolvedValue(client());
    const res = await authorize(validAuthorize);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Evil &lt;b&gt;Client&lt;/b&gt;");
    expect(html).not.toContain("<b>Client</b>");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(html).not.toContain("running on this computer");

    const payload = setCookiePayload(res, "authz_pending_")!;
    expect(payload).toMatchObject({
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      downstreamCodeChallenge: CHALLENGE,
      downstreamCodeChallengeMethod: "S256",
      downstreamState: "xyz",
    });
    expect(html).toContain(`name="csrf_token" value="${payload["csrfToken"] as string}"`);
  });

  it("warns about loopback redirects and accepts a different loopback port, storing the requested one", async () => {
    resolveClient.mockResolvedValue(client({ redirectUris: ["http://127.0.0.1:3000/cb"] }));
    const res = await authorize({ ...validAuthorize, redirect_uri: "http://127.0.0.1:54321/cb" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("running on this computer");
    expect(setCookiePayload(res, "authz_pending_")!["redirectUri"]).toBe("http://127.0.0.1:54321/cb");
  });

  it("rejects an unregistered redirect_uri", async () => {
    resolveClient.mockResolvedValue(client());
    const res = await authorize({ ...validAuthorize, redirect_uri: "https://evil.example/cb" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("maps InvalidClientError to 400 invalid_client", async () => {
    resolveClient.mockRejectedValue(new InvalidClientError("bad metadata"));
    const res = await authorize(validAuthorize);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client", error_description: "bad metadata" });
  });

  it("renders the login page with client disclosure directly in local mode", async () => {
    config.authMode = "local";
    resolveClient.mockResolvedValue(client());
    const res = await authorize(validAuthorize);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain('action="/auth/login"');
    expect(html).toContain("<strong>claude.ai</strong>");
    const payload = setCookiePayload(res, "login_pending_")!;
    expect(payload["downstreamCodeChallenge"]).toBe(CHALLENGE);
    expect(html).toMatch(/name="pending" value="[0-9a-f]{32}"/);
  });

  it.each([
    ["array client_id", { client_id: ["a", "b"] }],
    ["array state", { state: ["a", "b"] }],
    ["plain method", { code_challenge_method: "plain" }],
    ["missing method", { code_challenge_method: "" }],
    ["short challenge", { code_challenge: "short" }],
    ["challenge with bad characters", { code_challenge: "!".repeat(43) }],
    ["overlong state", { state: "s".repeat(513) }],
  ])("rejects %s with invalid_request", async (_name, override) => {
    resolveClient.mockResolvedValue(client());
    const params: Record<string, string | string[]> = { ...validAuthorize, ...override };
    if (params["code_challenge_method"] === "") delete params["code_challenge_method"];
    const res = await authorize(params);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("accepts a state of exactly 512 characters", async () => {
    resolveClient.mockResolvedValue(client());
    const res = await authorize({ ...validAuthorize, state: "s".repeat(512) });
    expect(res.status).toBe(200);
  });
});

describe("POST /auth/login", () => {
  function postLogin(form: Record<string, string>) {
    return fetch(`${base}/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
  }
  const loginCookie = () => JSON.stringify({
    clientId: "client-1",
    redirectUri: "https://claude.ai/cb",
    downstreamCodeChallenge: CHALLENGE,
    downstreamCodeChallengeMethod: "S256",
  });

  beforeEach(() => {
    (checkBruteForce as Mock).mockResolvedValue(true);
    db.oauthClient.findUnique.mockResolvedValue(client());
  });

  it("re-renders with client disclosure after a bad password", async () => {
    signedCookies["login_pending_p1"] = loginCookie();
    (validateLocalUser as Mock).mockRejectedValue(new Error("nope"));
    const res = await postLogin({ pending: "p1", username: "u", password: "bad" });
    const html = await res.text();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Invalid username or password.");
    expect(html).toContain("<strong>claude.ai</strong>");
  });

  it("re-renders with client disclosure when rate limited", async () => {
    signedCookies["login_pending_p1"] = loginCookie();
    (checkBruteForce as Mock).mockResolvedValue(false);
    const res = await postLogin({ pending: "p1", username: "u", password: "x" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("<strong>claude.ai</strong>");
  });

  it("returns 400 for a missing or malformed login cookie", async () => {
    const missing = await postLogin({ pending: "p1", username: "u", password: "x" });
    expect(missing.status).toBe(400);
    signedCookies["login_pending_p1"] = JSON.stringify({ clientId: "client-1" });
    const malformed = await postLogin({ pending: "p1", username: "u", password: "x" });
    expect(malformed.status).toBe(400);
  });

  it("issues an auth code with the requested redirect_uri on success", async () => {
    signedCookies["login_pending_p1"] = loginCookie();
    (validateLocalUser as Mock).mockResolvedValue("user-1");
    const res = await postLogin({ pending: "p1", username: "u", password: "good" });
    expect(res.status).toBe(302);
    expect(db.authCode.create.mock.calls[0]![0].data).toMatchObject({
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      codeChallengeMethod: "S256",
    });
    expect(isCleared(res, "login_pending_p1=")).toBe(true);
  });
});

describe("GET /auth/login", () => {
  it("shows the disclosure when the login cookie is present, and still renders without it", async () => {
    signedCookies["login_pending_p1"] = JSON.stringify({
      clientId: "client-1",
      redirectUri: "https://claude.ai/cb",
      downstreamCodeChallenge: CHALLENGE,
      downstreamCodeChallengeMethod: "S256",
    });
    db.oauthClient.findUnique.mockResolvedValue(client());
    expect(await (await fetch(`${base}/auth/login?pending=p1`)).text()).toContain("<strong>claude.ai</strong>");
    signedCookies = {};
    const bare = await fetch(`${base}/auth/login?pending=p1`);
    expect(bare.status).toBe(200);
    expect(await bare.text()).not.toContain("you will be redirected");
  });
});

describe("refresh_token grant", () => {
  function postRefresh() {
    return fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt", client_id: "client-1" }),
    });
  }
  beforeEach(() => {
    db.oauthSession.findUnique.mockResolvedValue({
      id: "sess-1",
      userId: "user-1",
      mcpClientId: "client-1",
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
      user: { id: "user-1", deactivatedAt: null },
    });
    db.oauthClient.findUnique.mockResolvedValue({ id: "client-1", clientSecretHash: null });
    (sendTokenResponse as Mock).mockImplementation((res: { json: (b: unknown) => void }) => res.json({}));
    (makeTokenPair as Mock).mockReturnValue({
      accessTokenHash: "a", expiresAt: new Date(), refreshTokenHash: "r", refreshExpiresAt: new Date(),
    });
  });

  it("rotates conditionally on the presented refresh token hash", async () => {
    db.oauthSession.updateMany.mockResolvedValue({ count: 1 });
    await postRefresh();
    expect(db.oauthSession.updateMany.mock.calls[0]![0].where).toEqual({ id: "sess-1", refreshTokenHash: "hashed:rt" });
    expect(sendTokenResponse).toHaveBeenCalled();
  });

  it("returns invalid_grant when a concurrent refresh already rotated the token", async () => {
    db.oauthSession.updateMany.mockResolvedValue({ count: 0 });
    const res = await postRefresh();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(sendTokenResponse).not.toHaveBeenCalled();
  });
});

describe("well-known protected resource metadata", () => {
  it("serves the root document unchanged and a /mcp document whose resource is the MCP URL", async () => {
    const root = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(root["resource"]).toBe("https://relay.example.com");
    const mcp = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(mcp).toEqual({
      resource: "https://relay.example.com/mcp",
      authorization_servers: ["https://relay.example.com"],
      bearer_methods_supported: ["header"],
    });
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

  function register(body: Record<string, unknown>) {
    return fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3000/cb"], ...body }),
    });
  }

  it.each(["client_secret_basic", "client_secret_post"])("rejects token_endpoint_auth_method %s", async (method) => {
    const res = await register({ token_endpoint_auth_method: method });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
    expect(db.oauthClient.create).not.toHaveBeenCalled();
  });

  it("accepts an explicit \"none\" and creates a public client", async () => {
    db.oauthClient.create.mockResolvedValue({ id: "cid", createdAt: new Date(0) });
    const res = await register({ token_endpoint_auth_method: "none" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token_endpoint_auth_method: string }).token_endpoint_auth_method).toBe("none");
    expect(db.oauthClient.create.mock.calls[0]![0].data.clientSecretHash).toBeNull();
  });

  it("reports token_endpoint_auth_method none when it was omitted", async () => {
    db.oauthClient.create.mockResolvedValue({ id: "cid", createdAt: new Date(0) });
    const res = await register({});
    expect(((await res.json()) as { token_endpoint_auth_method: string }).token_endpoint_auth_method).toBe("none");
  });

  it("rejects unsupported grant_types", async () => {
    const res = await register({ grant_types: ["authorization_code", "client_credentials"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_client_metadata");
    expect(db.oauthClient.create).not.toHaveBeenCalled();
  });
});
