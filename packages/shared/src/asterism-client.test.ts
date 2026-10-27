import { describe, it, expect, vi } from "vitest";
import {
  AsterismError,
  clientIdFor,
  discoverAsterism,
  pollDeviceToken,
  refreshTokens,
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
  device_code: "dev", user_code: "ABCD-1234", verification_uri: `${ISSUER}/oauth/device`,
  verification_uri_complete: `${ISSUER}/oauth/device?user_code=ABCD-1234`, expires_in: 900, interval: 5,
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

describe("requestDeviceAuthorization", () => {
  it("sends client_id, scope and resource", async () => {
    const { fetch, calls } = queue(json(200, DC));
    const dc = await requestDeviceAuthorization(ENDPOINTS, { clientId: "cid", scope: "relay offline_access", resource: `${RELAY}/mcp` }, { fetch });
    expect(dc.user_code).toBe("ABCD-1234");
    expect(Object.fromEntries(calls[0]!.body!)).toEqual({ client_id: "cid", scope: "relay offline_access", resource: `${RELAY}/mcp` });
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
