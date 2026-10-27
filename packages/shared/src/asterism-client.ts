import { assertSecureHttpUrl, isSameOrigin } from "./relay-socket.js";
import { sleep } from "./cli-util.js";

/**
 * Client side of the asterism authorization server, shared by the user CLI, the node CLI
 * and the hub CLI: discovery from the relay's RFC 9728 metadata, the RFC 8628 device
 * flow, and refresh. The relay is purely a resource server, so every sign-in goes to
 * asterism, and the relay URL is only used to find it.
 */

/** The three device-flow clients. Each is a CIMD client served by the relay (see
 * relay/src/client-metadata.ts); asterism keeps one grant per (user, client, resource), so
 * they must stay separate or revoking or reusing one would end all three. */
export type ClientKind = "cli" | "node" | "hub";

/** The client_id for `kind`: the URL of the metadata document the relay serves. */
export function clientIdFor(relayUrl: string, kind: ClientKind): string {
  return `${relayUrl}/clients/${kind}.json`;
}

/** The token audience for both /mcp and /api, sent as `resource` on every asterism request. */
export function resourceFor(relayUrl: string): string {
  return `${relayUrl}/mcp`;
}

/** An OAuth error response from asterism (or an unusable one). Callers branch on `code`,
 * never on the message, which is for display only. */
export class AsterismError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AsterismError";
  }
}

export interface AsterismEndpoints {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Injection points for tests. */
export interface AsterismDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_MS = 5_000;

async function fetchJson(
  url: string,
  init: RequestInit,
  deps: AsterismDeps
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  assertSecureHttpUrl(url);
  const res = await (deps.fetch ?? fetch)(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // A redirect would leave the origin assertSecureHttpUrl just checked.
    redirect: "error",
  });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, body };
}

function postForm(url: string, params: Record<string, string>, deps: AsterismDeps) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }, deps);
}

/** RFC 8414 §3.1: the well-known segment goes between the host and the issuer's path. */
function authServerMetadataUrl(issuer: string): string {
  const u = new URL(issuer);
  return `${u.origin}/.well-known/oauth-authorization-server${u.pathname === "/" ? "" : u.pathname}`;
}

function requireString(obj: Record<string, unknown>, key: string, what: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") throw new AsterismError("invalid_metadata", `${what} is missing ${key}`);
  return v;
}

/**
 * Finds the authorization server for a relay: fetches the relay's protected-resource metadata,
 * checks its `resource` is exactly `${relay}/mcp`, takes the first authorization server, fetches
 * that server's metadata and checks `issuer` matches the URL it was found under. Every URL must
 * pass assertSecureHttpUrl (https, or http to localhost).
 */
export async function discoverAsterism(relayUrl: string, deps: AsterismDeps = {}): Promise<AsterismEndpoints> {
  const prm = await fetchJson(`${relayUrl}/.well-known/oauth-protected-resource/mcp`, {}, deps);
  if (!prm.ok || !prm.body) {
    throw new AsterismError("invalid_metadata", `Could not read ${relayUrl}'s protected-resource metadata (status ${prm.status})`);
  }
  if (prm.body["resource"] !== resourceFor(relayUrl)) {
    throw new AsterismError("invalid_metadata", `${relayUrl}'s protected-resource metadata is for a different resource`);
  }
  const servers = prm.body["authorization_servers"];
  const issuer = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof issuer !== "string" || issuer === "") {
    throw new AsterismError("invalid_metadata", `${relayUrl} does not name an authorization server`);
  }
  assertSecureHttpUrl(issuer);

  const as = await fetchJson(authServerMetadataUrl(issuer), {}, deps);
  if (!as.ok || !as.body) {
    throw new AsterismError("invalid_metadata", `Could not read ${issuer}'s authorization server metadata (status ${as.status})`);
  }
  if (as.body["issuer"] !== issuer) {
    throw new AsterismError("invalid_metadata", `Authorization server metadata at ${issuer} names a different issuer`);
  }
  const deviceAuthorizationEndpoint = requireString(as.body, "device_authorization_endpoint", `${issuer}'s metadata`);
  const tokenEndpoint = requireString(as.body, "token_endpoint", `${issuer}'s metadata`);
  assertSecureHttpUrl(deviceAuthorizationEndpoint);
  assertSecureHttpUrl(tokenEndpoint);
  return { issuer, deviceAuthorizationEndpoint, tokenEndpoint };
}

/** RFC 8628 §3.1. `scope` is space-delimited; `resource` is `resourceFor(relay)`. */
export async function requestDeviceAuthorization(
  endpoints: AsterismEndpoints,
  params: { clientId: string; scope: string; resource: string },
  deps: AsterismDeps = {}
): Promise<DeviceAuthorization> {
  const r = await postForm(endpoints.deviceAuthorizationEndpoint, {
    client_id: params.clientId,
    scope: params.scope,
    resource: params.resource,
  }, deps);
  if (!r.ok || !r.body) {
    const code = typeof r.body?.["error"] === "string" ? r.body["error"] : "server_error";
    throw new AsterismError(code, `Could not start sign-in: ${code}${r.body?.["error_description"] ? ` (${String(r.body["error_description"])})` : ""}`);
  }
  const device_code = requireString(r.body, "device_code", "device authorization response");
  const user_code = requireString(r.body, "user_code", "device authorization response");
  const verification_uri = requireString(r.body, "verification_uri", "device authorization response");
  const expires_in = r.body["expires_in"];
  if (typeof expires_in !== "number") throw new AsterismError("invalid_response", "device authorization response is missing expires_in");
  const interval = typeof r.body["interval"] === "number" ? r.body["interval"] : DEFAULT_POLL_INTERVAL_S;
  const complete = r.body["verification_uri_complete"];
  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete: typeof complete === "string" && complete !== "" ? complete : verification_uri,
    expires_in,
    interval,
  };
}

/**
 * The verification URL to open in a browser, or null if it is not on the authorization
 * server's own origin (a compromised or misconfigured response must not make us open an
 * arbitrary URL).
 */
export function verificationUrlToOpen(endpoints: AsterismEndpoints, dc: DeviceAuthorization): string | null {
  return isSameOrigin(endpoints.issuer, dc.verification_uri_complete) ? dc.verification_uri_complete : null;
}

function parseTokenResponse(body: Record<string, unknown>): TokenResponse {
  const access_token = requireString(body, "access_token", "token response");
  const expires_in = body["expires_in"];
  if (typeof expires_in !== "number") throw new AsterismError("invalid_response", "token response is missing expires_in");
  return {
    access_token,
    expires_in,
    refresh_token: typeof body["refresh_token"] === "string" && body["refresh_token"] !== "" ? body["refresh_token"] : undefined,
    scope: typeof body["scope"] === "string" ? body["scope"] : undefined,
  };
}

/**
 * Polls the token endpoint until the user approves (RFC 8628 §3.5). authorization_pending keeps
 * waiting, slow_down adds 5 seconds to the interval, and expired_token, access_denied and any
 * other error end it with an AsterismError carrying the `error` code. Transient failures (network
 * errors, 5xx, 429) are retried until the code expires.
 */
export async function pollDeviceToken(
  endpoints: AsterismEndpoints,
  dc: Pick<DeviceAuthorization, "device_code" | "expires_in" | "interval">,
  params: { clientId: string; resource: string },
  deps: AsterismDeps = {}
): Promise<TokenResponse> {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const deadline = now() + dc.expires_in * 1000;
  let intervalMs = dc.interval * 1000;

  for (;;) {
    await wait(intervalMs);
    if (now() >= deadline) break;

    let r;
    try {
      r = await postForm(endpoints.tokenEndpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc.device_code,
        client_id: params.clientId,
        resource: params.resource,
      }, deps);
    } catch {
      continue; // DNS hiccup, reset connection, laptop suspend: keep trying until the code expires.
    }

    if (r.ok && r.body) return parseTokenResponse(r.body);

    const code = r.status === 400 && typeof r.body?.["error"] === "string" ? r.body["error"] : null;
    if (code === null) {
      if (r.status >= 500 || r.status === 429) continue;
      throw new AsterismError("server_error", `Unexpected response from the authorization server (status ${r.status})`);
    }
    switch (code) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalMs += SLOW_DOWN_STEP_MS;
        break;
      case "expired_token":
        throw new AsterismError(code, "The sign-in code expired before it was approved. Run the command again.");
      case "access_denied":
        throw new AsterismError(code, "Sign-in was denied.");
      default:
        throw new AsterismError(code, `Sign-in failed: ${code}`);
    }
  }
  throw new AsterismError("expired_token", "The sign-in code expired before it was approved. Run the command again.");
}

/**
 * Exchanges a refresh token. asterism rotates it: the response carries the new one, which the
 * caller must persist before using the new access token. Throws AsterismError (`invalid_grant`
 * when the token is used, revoked, expired or its grant ended); network failures throw plain errors.
 */
export async function refreshTokens(
  endpoints: AsterismEndpoints,
  params: { clientId: string; resource: string; refreshToken: string },
  deps: AsterismDeps = {}
): Promise<TokenResponse> {
  const r = await postForm(endpoints.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    resource: params.resource,
  }, deps);
  if (r.ok && r.body) return parseTokenResponse(r.body);
  const code = typeof r.body?.["error"] === "string" ? r.body["error"] : "server_error";
  throw new AsterismError(code, `Token refresh failed: ${code}`);
}

/**
 * The whole interactive sign-in: discovery, device authorization, then polling. `onCode` is
 * called once with the code to show the user and the URL it is safe to open in a browser
 * (null if the response named a URL off the authorization server's origin). Returns the
 * endpoints too, so a caller can refresh later without rediscovering.
 */
export async function deviceSignIn(
  relayUrl: string,
  params: {
    kind: ClientKind;
    scope: string;
    onCode: (dc: DeviceAuthorization, openUrl: string | null) => void | Promise<void>;
  },
  deps: AsterismDeps = {}
): Promise<{ endpoints: AsterismEndpoints; tokens: TokenResponse }> {
  const endpoints = await discoverAsterism(relayUrl, deps);
  const clientId = clientIdFor(relayUrl, params.kind);
  const resource = resourceFor(relayUrl);
  const dc = await requestDeviceAuthorization(endpoints, { clientId, scope: params.scope, resource }, deps);
  await params.onCode(dc, verificationUrlToOpen(endpoints, dc));
  const tokens = await pollDeviceToken(endpoints, dc, { clientId, resource }, deps);
  return { endpoints, tokens };
}
