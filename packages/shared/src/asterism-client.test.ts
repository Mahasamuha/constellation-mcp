import { describe, it, expect, vi } from "vitest";
import {
  AsterismError,
  clientIdFor,
  deviceSignIn,
  discoverAsterism,
  pollDeviceToken,
  refreshTokens,
  revokeRefreshToken,
  registerExecutor,
  requestDeviceAuthorization,
  verificationUrlToOpen,
  type AsterismEndpoints,
  type DeviceAuthorization,
} from "./asterism-client.js";

const RELAY = "https://relay.example.com";
const ISSUER = "https://auth.example.com";
const ENDPOINTS: AsterismEndpoints = {
  issuer: ISSUER,
  deviceAuthorizationEndpoint: `${ISSUER}/oauth/device/code`,
  tokenEndpoint: `${ISSUER}/oauth/token`,
};
const DC: DeviceAuthorization = {
  device_code: "dev", user_code: "ABCD-2345", verification_uri: `${ISSUER}/oauth/device`,
  verification_uri_complete: `${ISSUER}/oauth/device?user_code=ABCD-2345`, expires_in: 900, interval: 5,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch that serves each queued response in turn and records the requests. */
function queue(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body instanceof URLSearchParams ? init.body : null });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("clientIdFor", () => {
  it("is the URL of the relay's metadata document for that client", () => {
    expect(clientIdFor(RELAY, "cli")).toBe(`${RELAY}/clients/cli.json`);
    expect(clientIdFor(RELAY, "node")).toBe(`${RELAY}/clients/node.json`);
    expect(clientIdFor(RELAY, "hub")).toBe(`${RELAY}/clients/hub.json`);
  });
});

describe("discoverAsterism", () => {
  const prm = { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] };
  const asMeta = { issuer: ISSUER, device_authorization_endpoint: ENDPOINTS.deviceAuthorizationEndpoint, token_endpoint: ENDPOINTS.tokenEndpoint };

  it("follows the relay's metadata to the issuer's endpoints", async () => {
    const { fetch, calls } = queue(json(200, prm), json(200, asMeta));
    await expect(discoverAsterism(RELAY, { fetch })).resolves.toEqual(ENDPOINTS);
    expect(calls.map((c) => c.url)).toEqual([
      `${RELAY}/.well-known/oauth-protected-resource/mcp`,
      `${ISSUER}/.well-known/oauth-authorization-server`,
    ]);
  });

  it("puts the well-known segment before an issuer path (RFC 8414)", async () => {
    const issuer = "https://auth.example.com/tenant";
    const { fetch, calls } = queue(json(200, { ...prm, authorization_servers: [issuer] }), json(200, { ...asMeta, issuer }));
    await discoverAsterism(RELAY, { fetch });
    expect(calls[1]!.url).toBe("https://auth.example.com/.well-known/oauth-authorization-server/tenant");
  });

  it("rejects metadata for a different resource", async () => {
    const { fetch } = queue(json(200, { ...prm, resource: "https://other.example.com/mcp" }));
    await expect(discoverAsterism(RELAY, { fetch })).rejects.toMatchObject({ code: "invalid_metadata" });
  });

  it("rejects an issuer that does not match exactly", async () => {
    const { fetch } = queue(json(200, prm), json(200, { ...asMeta, issuer: `${ISSUER}/` }));
    await expect(discoverAsterism(RELAY, { fetch })).rejects.toMatchObject({ code: "invalid_metadata" });
  });

  it("rejects missing endpoints and no authorization server", async () => {
    await expect(discoverAsterism(RELAY, queue(json(200, { ...prm, authorization_servers: [] })))).rejects.toBeInstanceOf(AsterismError);
    const { fetch } = queue(json(200, prm), json(200, { issuer: ISSUER, token_endpoint: ENDPOINTS.tokenEndpoint }));
    await expect(discoverAsterism(RELAY, { fetch })).rejects.toMatchObject({ code: "invalid_metadata" });
  });

  it("refuses plaintext http to a non-local host before fetching", async () => {
    const { fetch, calls } = queue();
    await expect(discoverAsterism("http://relay.example.com", { fetch })).rejects.toThrow(/Refusing to connect/);
    expect(calls).toHaveLength(0);

    const q = queue(json(200, { resource: `${RELAY}/mcp`, authorization_servers: ["http://auth.example.com"] }));
    await expect(discoverAsterism(RELAY, q)).rejects.toThrow(/Refusing to connect/);
  });
});

describe("discoverAsterism — pinning and origins", () => {
  const prm = { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] };
  const asMeta = { issuer: ISSUER, device_authorization_endpoint: ENDPOINTS.deviceAuthorizationEndpoint, token_endpoint: ENDPOINTS.tokenEndpoint };

  it("refuses a different issuer than the pinned one, before contacting it", async () => {
    const { fetch, calls } = queue(json(200, prm));
    await expect(discoverAsterism(RELAY, { fetch }, "https://other.example.com"))
      .rejects.toMatchObject({ code: "issuer_changed", message: expect.stringContaining("different authorization server") });
    expect(calls).toHaveLength(1);
  });

  it("accepts the pinned issuer", async () => {
    const { fetch } = queue(json(200, prm), json(200, asMeta));
    await expect(discoverAsterism(RELAY, { fetch }, ISSUER)).resolves.toMatchObject({ issuer: ISSUER });
  });

  it("accepts a loopback http issuer only for a loopback relay", async () => {
    const local = "http://localhost:4000";
    const issuer = "http://localhost:5000";
    const meta = { issuer, device_authorization_endpoint: `${issuer}/d`, token_endpoint: `${issuer}/t` };
    const ok = queue(json(200, { resource: `${local}/mcp`, authorization_servers: [issuer] }), json(200, meta));
    await expect(discoverAsterism(local, ok)).resolves.toMatchObject({ issuer });

    const bad = queue(json(200, { resource: `${RELAY}/mcp`, authorization_servers: [issuer] }));
    await expect(discoverAsterism(RELAY, bad)).rejects.toMatchObject({ code: "invalid_metadata" });
    expect(bad.calls).toHaveLength(1);
  });

  it.each(["device_authorization_endpoint", "token_endpoint", "revocation_endpoint"])("requires %s to share the issuer's origin", async (key) => {
    const { fetch } = queue(json(200, prm), json(200, { ...asMeta, [key]: "https://evil.example.com/x" }));
    await expect(discoverAsterism(RELAY, { fetch })).rejects.toMatchObject({ code: "invalid_metadata" });
  });

  it("reports the revocation endpoint when advertised", async () => {
    const { fetch } = queue(json(200, prm), json(200, { ...asMeta, revocation_endpoint: `${ISSUER}/oauth/revoke` }));
    await expect(discoverAsterism(RELAY, { fetch })).resolves.toMatchObject({ revocationEndpoint: `${ISSUER}/oauth/revoke` });
  });

  it("refuses an unknown scheme or odd spelling of http before fetching", async () => {
    const { fetch, calls } = queue();
    await expect(discoverAsterism("HTTP://relay.example.com", { fetch })).rejects.toThrow(/Refusing to connect/);
    await expect(discoverAsterism("ftp://relay.example.com", { fetch })).rejects.toThrow(/Refusing to connect/);
    expect(calls).toHaveLength(0);
  });
});

describe("requestDeviceAuthorization", () => {
  it("sends client_id, scope and resource", async () => {
    const { fetch, calls } = queue(json(200, DC));
    const dc = await requestDeviceAuthorization(ENDPOINTS, { clientId: "cid", scope: "relay offline_access", resource: `${RELAY}/mcp` }, { fetch });
    expect(dc.user_code).toBe("ABCD-2345");
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({ client_id: "cid", scope: "relay offline_access", resource: `${RELAY}/mcp` });
  });

  it("rejects a malformed user code, expires_in and the like", async () => {
    const ask = (body: unknown) => requestDeviceAuthorization(ENDPOINTS, { clientId: "c", scope: "x", resource: "r" }, { fetch: queue(json(200, body)).fetch });
    await expect(ask({ ...DC, user_code: "\u001b[2JABCD-2345" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(ask({ ...DC, user_code: "ABCD-1111" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(ask({ ...DC, expires_in: 0 })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(ask({ ...DC, expires_in: -5 })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("clamps the interval to 1-60 seconds and defaults a non-number", async () => {
    const ask = (interval: unknown) => requestDeviceAuthorization(ENDPOINTS, { clientId: "c", scope: "x", resource: "r" }, { fetch: queue(json(200, { ...DC, interval })).fetch });
    expect((await ask(0)).interval).toBe(1);
    expect((await ask(-3)).interval).toBe(1);
    expect((await ask(100000)).interval).toBe(60);
    expect((await ask("5")).interval).toBe(5);
  });

  it("strips control characters from a server-supplied error description", async () => {
    const { fetch } = queue(json(400, { error: "invalid_scope", error_description: "\u001b[2Jpay\u202eevil\u0007" }));
    const err = await requestDeviceAuthorization(ENDPOINTS, { clientId: "c", scope: "x", resource: "r" }, { fetch }).catch((e: Error) => e);
    expect((err as Error).message).toContain("payevil");
    // eslint-disable-next-line no-control-regex -- asserting control characters were stripped
    expect((err as Error).message).not.toMatch(/[\u0000-\u001f\u202e]/);
  });

  it("surfaces the error code", async () => {
    const { fetch } = queue(json(400, { error: "invalid_scope" }));
    await expect(requestDeviceAuthorization(ENDPOINTS, { clientId: "c", scope: "x", resource: "r" }, { fetch }))
      .rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("verificationUrlToOpen", () => {
  it("opens only URLs on the issuer's origin, not the relay's", () => {
    expect(verificationUrlToOpen(ENDPOINTS, DC)).toBe(DC.verification_uri_complete);
    expect(verificationUrlToOpen(ENDPOINTS, { ...DC, verification_uri_complete: `${RELAY}/activate` })).toBeNull();
    expect(verificationUrlToOpen(ENDPOINTS, { ...DC, verification_uri_complete: "javascript:alert(1)" })).toBeNull();
  });

  it("returns the normalized href", () => {
    const host = new URL(ISSUER).host;
    expect(verificationUrlToOpen(ENDPOINTS, { ...DC, verification_uri_complete: `${new URL(ISSUER).protocol}//${host.toUpperCase()}/a/../activate?x=1` }))
      .toBe(`${ISSUER}/activate?x=1`);
  });

  it.each(["\\", " ", "\t", "\n", "\u0000", "\u009b"])("refuses a URL containing %j", (bad) => {
    expect(verificationUrlToOpen(ENDPOINTS, { ...DC, verification_uri_complete: `${ISSUER}/activate${bad}x` })).toBeNull();
  });
});

describe("pollDeviceToken", () => {
  const params = { clientId: "cid", resource: `${RELAY}/mcp` };
  const token = { access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt", scope: "relay offline_access" };

  function run(responses: Array<Response | Error>) {
    const q = queue(...responses);
    const sleeps: number[] = [];
    const p = pollDeviceToken(ENDPOINTS, DC, params, { fetch: q.fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    return { p, sleeps, calls: q.calls };
  }

  it("keeps waiting on authorization_pending and returns the tokens", async () => {
    const { p, sleeps, calls } = run([json(400, { error: "authorization_pending" }), json(200, token)]);
    await expect(p).resolves.toMatchObject({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    expect(sleeps).toEqual([5000, 5000]);
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev", client_id: "cid", resource: `${RELAY}/mcp`,
    });
  });

  it("adds 5 seconds on every slow_down", async () => {
    const { p, sleeps } = run([json(400, { error: "slow_down" }), json(400, { error: "slow_down" }), json(200, token)]);
    await p;
    expect(sleeps).toEqual([5000, 10000, 15000]);
  });

  it.each(["expired_token", "access_denied", "invalid_grant", "invalid_target"])("ends on %s with that code", async (error) => {
    const { p } = run([json(400, { error, error_description: "ignore me" })]);
    await expect(p).rejects.toMatchObject({ name: "AsterismError", code: error });
  });

  it("has clear messages for expiry and denial", async () => {
    await expect(run([json(400, { error: "expired_token" })]).p).rejects.toThrow(/expired/);
    await expect(run([json(400, { error: "access_denied" })]).p).rejects.toThrow(/denied/);
  });

  it("rides out network errors and 5xx", async () => {
    const { p } = run([new Error("ECONNRESET"), json(503, {}), json(200, token)]);
    await expect(p).resolves.toMatchObject({ access_token: "at" });
  });

  it("clamps the interval it waits to 1-60 seconds", async () => {
    const wait = async (interval: number) => {
      const sleeps: number[] = [];
      const q = queue(json(200, token));
      await pollDeviceToken(ENDPOINTS, { ...DC, interval }, params, { fetch: q.fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
      return sleeps[0];
    };
    expect(await wait(0)).toBe(1000);
    expect(await wait(NaN)).toBe(5000);
    expect(await wait(9999)).toBe(60_000);
  });

  it("never lets slow_down push the interval past 60 seconds", async () => {
    const sleeps: number[] = [];
    const q = queue(json(400, { error: "slow_down" }), json(200, token));
    await pollDeviceToken(ENDPOINTS, { ...DC, interval: 58 }, params, { fetch: q.fetch, sleep: async (ms) => { sleeps.push(ms); }, now: () => 0 });
    expect(sleeps).toEqual([58_000, 60_000]);
  });

  it.each([NaN, 0, -1, Infinity])("refuses expires_in %s", async (expires_in) => {
    const q = queue();
    await expect(pollDeviceToken(ENDPOINTS, { ...DC, expires_in }, params, { fetch: q.fetch, sleep: async () => {}, now: () => 0 }))
      .rejects.toMatchObject({ code: "invalid_response" });
    expect(q.calls).toHaveLength(0);
  });

  it("rethrows a non-network failure instead of retrying it", async () => {
    const q = queue(json(200, token));
    const bad = { ...ENDPOINTS, tokenEndpoint: "http://auth.example.com/oauth/token" };
    await expect(pollDeviceToken(bad, DC, params, { fetch: q.fetch, sleep: async () => {}, now: () => 0 })).rejects.toThrow(/Refusing to connect/);
    expect(q.calls).toHaveLength(0);
  });

  it("does not retry a redirect", async () => {
    const redirect = Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    const q = queue(redirect, json(200, token));
    await expect(pollDeviceToken(ENDPOINTS, DC, params, { fetch: q.fetch, sleep: async () => {}, now: () => 0 })).rejects.toMatchObject({ code: "invalid_response" });
    expect(q.calls).toHaveLength(1);
  });

  it("retries 429 and timeouts", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { p } = run([json(429, {}), timeout, json(200, token)]);
    await expect(p).resolves.toMatchObject({ access_token: "at" });
  });

  it("gives up with expired_token once the code's lifetime passes", async () => {
    let t = 0;
    const q = queue(json(400, { error: "authorization_pending" }));
    const p = pollDeviceToken(ENDPOINTS, DC, params, { fetch: q.fetch, sleep: async () => { t += 1_000_000; }, now: () => t });
    await expect(p).rejects.toMatchObject({ code: "expired_token" });
  });
});

describe("refreshTokens", () => {
  it("sends client_id and resource and returns the rotated token", async () => {
    const { fetch, calls } = queue(json(200, { access_token: "at2", token_type: "Bearer", expires_in: 600, refresh_token: "rt2" }));
    const t = await refreshTokens(ENDPOINTS, { clientId: "cid", resource: `${RELAY}/mcp`, refreshToken: "rt1" }, { fetch });
    expect(t).toMatchObject({ access_token: "at2", refresh_token: "rt2" });
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({
      grant_type: "refresh_token", refresh_token: "rt1", client_id: "cid", resource: `${RELAY}/mcp`,
    });
  });

  it("throws invalid_grant by code", async () => {
    const { fetch } = queue(json(400, { error: "invalid_grant", error_description: "Refresh token already used" }));
    await expect(refreshTokens(ENDPOINTS, { clientId: "c", resource: "r", refreshToken: "x" }, { fetch }))
      .rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("revokeRefreshToken", () => {
  const withRevocation = { ...ENDPOINTS, revocationEndpoint: `${ISSUER}/oauth/revoke` };

  it("posts token and client_id to the revocation endpoint", async () => {
    const { fetch, calls } = queue(new Response(null, { status: 200 }));
    await expect(revokeRefreshToken(withRevocation, { clientId: "cid", refreshToken: "rt" }, { fetch })).resolves.toBe(true);
    expect(calls[0]!.url).toBe(`${ISSUER}/oauth/revoke`);
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({ token: "rt", token_type_hint: "refresh_token", client_id: "cid" });
  });

  it("does nothing when the server advertises no revocation endpoint", async () => {
    const { fetch, calls } = queue();
    await expect(revokeRefreshToken(ENDPOINTS, { clientId: "cid", refreshToken: "rt" }, { fetch })).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("throws on a failure status", async () => {
    const { fetch } = queue(json(400, { error: "invalid_client" }));
    await expect(revokeRefreshToken(withRevocation, { clientId: "cid", refreshToken: "rt" }, { fetch })).rejects.toBeInstanceOf(AsterismError);
  });
});

describe("registerExecutor", () => {
  const ok = { access_token: "ab".repeat(32), host: "laptop" };

  it("posts the type and host with the access token and refuses redirects", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return json(200, ok); }) as unknown as typeof globalThis.fetch;
    await expect(registerExecutor(RELAY, "at", { type: "node", host: "laptop" }, { fetch })).resolves.toEqual({ ok: true, ...ok });
    expect(seen[0]!.url).toBe(`${RELAY}/api/executors/register`);
    expect(seen[0]!.init!.redirect).toBe("error");
    expect((seen[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer at");
    expect(JSON.parse(seen[0]!.init!.body as string)).toEqual({ type: "node", host: "laptop" });
  });

  it("refuses a plaintext remote relay without sending the token", async () => {
    const { fetch, calls } = queue();
    const r = await registerExecutor("http://relay.example.com", "at", { type: "hub", host: "h" }, { fetch });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("Refusing to connect") });
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal, with control characters stripped", async () => {
    const { fetch } = queue(json(403, { error: "insufficient_scope", error_description: "\u001b[2Jneeds admin" }));
    const r = await registerExecutor(RELAY, "at", { type: "hub", host: "h" }, { fetch });
    expect(r).toEqual({ ok: false, message: "The relay refused the registration: [2Jneeds admin" });
  });

  it("reports a network failure or redirect instead of throwing", async () => {
    const { fetch } = queue(new TypeError("fetch failed"));
    await expect(registerExecutor(RELAY, "at", { type: "node", host: "h" }, { fetch })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("Could not reach") });
  });

  it.each([
    ["a short token", { access_token: "abc", host: "laptop" }],
    ["an upper-case token", { access_token: "AB".repeat(32), host: "laptop" }],
    ["a token with a line break", { access_token: `${"ab".repeat(31)}\nX=1`, host: "laptop" }],
    ["a host with an escape sequence", { access_token: "ab".repeat(32), host: "la\u001b[2Jptop" }],
    ["a host with a space", { access_token: "ab".repeat(32), host: "my laptop" }],
  ])("refuses %s before returning it", async (_name, body) => {
    const { fetch } = queue(json(200, body));
    const r = await registerExecutor(RELAY, "at", { type: "node", host: "laptop" }, { fetch });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("malformed") });
    expect(JSON.stringify(r)).not.toContain("access_token");
  });

  it("reports a malformed success body", async () => {
    const { fetch } = queue(new Response("<html>", { status: 200 }));
    await expect(registerExecutor(RELAY, "at", { type: "node", host: "h" }, { fetch })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("status 200") });
  });
});

describe("deviceSignIn — issuer pinning", () => {
  const prm = { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] };

  it("throws issuer_changed before any code is shown when the relay names another issuer", async () => {
    const { fetch, calls } = queue(json(200, prm));
    const onCode = vi.fn();
    await expect(deviceSignIn(RELAY, { kind: "cli", scope: "relay", onCode, expectedIssuer: "https://old.example.com" }, { fetch }))
      .rejects.toMatchObject({ code: "issuer_changed" });
    expect(onCode).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
