import { assertSecureHttpUrl, isLoopbackUrl, isSameOrigin } from "./relay-socket.js";
import { sleep } from "./cli-util.js";
import { isValidUserCode, sanitizeForTerminal } from "./terminal-text.js";

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
 * never on the message, which is for display only. Both can carry server-supplied text, so both
 * are stripped of control and bidi characters here, once, rather than at every print site. */
export class AsterismError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(sanitizeForTerminal(message));
    this.name = "AsterismError";
    this.code = sanitizeForTerminal(code, 100);
  }
}

/** A request that failed in transit (DNS, refused or reset connection, timeout). The only kind of
 * failure the device poller retries; everything else is deterministic. */
export class NetworkError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "NetworkError";
  }
}

export interface AsterismEndpoints {
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  /** RFC 7009, if the server advertises one. */
  revocationEndpoint?: string;
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
  /** Per-request timeout; default 15 s. */
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_MS = 5_000;
/** The poll interval is whatever the server says, but kept within these bounds (RFC 8628's default
 * is 5 s): a zero or NaN interval would hammer the token endpoint, a huge one would hang the CLI. */
const MIN_POLL_INTERVAL_S = 1;
const MAX_POLL_INTERVAL_S = 60;
/** Longest we will keep polling for one device code, whatever expires_in says. */
const MAX_DEVICE_CODE_LIFETIME_S = 3_600;

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  deps: AsterismDeps
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  assertSecureHttpUrl(url);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      // A redirect would leave the origin assertSecureHttpUrl just checked.
      redirect: "error",
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: unknown } }).cause;
    if (typeof cause?.message === "string" && /redirect/i.test(cause.message)) {
      throw new AsterismError("invalid_response", "The authorization server answered with a redirect, which is refused");
    }
    throw new NetworkError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`, err);
  }
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
 * pass assertSecureHttpUrl (https, or http to localhost), an http issuer is accepted only when the
 * relay itself is on localhost, and the endpoints must sit on the issuer's own origin.
 *
 * `expectedIssuer` pins the authorization server: a stored session or an earlier step of a
 * two-step flow remembers who it signed in with, and a relay that now names someone else must
 * not receive the refresh token. A different issuer throws `issuer_changed` before that server
 * is contacted.
 */
export async function discoverAsterism(
  relayUrl: string,
  deps: AsterismDeps = {},
  expectedIssuer?: string
): Promise<AsterismEndpoints> {
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
  if (new URL(issuer).protocol === "http:" && !isLoopbackUrl(relayUrl)) {
    throw new AsterismError("invalid_metadata", `${relayUrl} names a plaintext http authorization server; that is only accepted when the relay is on localhost`);
  }
  if (expectedIssuer !== undefined && issuer !== expectedIssuer) {
    throw new AsterismError(
      "issuer_changed",
      `${relayUrl} now names a different authorization server (${issuer}) than the one you signed in with (${expectedIssuer}). Nothing was sent to it. If you trust the change, sign in again.`
    );
  }

  const as = await fetchJson(authServerMetadataUrl(issuer), {}, deps);
  if (!as.ok || !as.body) {
    throw new AsterismError("invalid_metadata", `Could not read ${issuer}'s authorization server metadata (status ${as.status})`);
  }
  if (as.body["issuer"] !== issuer) {
    throw new AsterismError("invalid_metadata", `Authorization server metadata at ${issuer} names a different issuer`);
  }
  const deviceAuthorizationEndpoint = requireString(as.body, "device_authorization_endpoint", `${issuer}'s metadata`);
  const tokenEndpoint = requireString(as.body, "token_endpoint", `${issuer}'s metadata`);
  const revocation = as.body["revocation_endpoint"];
  const revocationEndpoint = typeof revocation === "string" && revocation !== "" ? revocation : undefined;
  for (const endpoint of [deviceAuthorizationEndpoint, tokenEndpoint, revocationEndpoint]) {
    if (endpoint === undefined) continue;
    assertSecureHttpUrl(endpoint);
    if (!isSameOrigin(issuer, endpoint)) {
      throw new AsterismError("invalid_metadata", `${issuer}'s metadata names an endpoint on a different origin (${endpoint})`);
    }
  }
  return { issuer, deviceAuthorizationEndpoint, tokenEndpoint, ...(revocationEndpoint ? { revocationEndpoint } : {}) };
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
  if (!isValidUserCode(user_code)) {
    throw new AsterismError("invalid_response", "device authorization response has a malformed user_code");
  }
  const expires_in = r.body["expires_in"];
  if (!isPositiveFinite(expires_in)) throw new AsterismError("invalid_response", "device authorization response has a missing or invalid expires_in");
  const interval = clampPollInterval(r.body["interval"]);
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

/** A server-supplied poll interval in seconds, kept within 1 to 60; the default if it is not a number. */
function clampPollInterval(interval: unknown): number {
  if (typeof interval !== "number" || !Number.isFinite(interval)) return DEFAULT_POLL_INTERVAL_S;
  return Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, interval));
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
  if (!isPositiveFinite(expires_in)) throw new AsterismError("invalid_response", "token response has a missing or invalid expires_in");
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
 * errors and timeouts, 5xx, 429) are retried until the code expires; anything else, such as a
 * refused URL, is rethrown at once. The interval is kept within 1 to 60 seconds and `expires_in`
 * must be a positive number.
 */
export async function pollDeviceToken(
  endpoints: AsterismEndpoints,
  dc: Pick<DeviceAuthorization, "device_code" | "expires_in" | "interval">,
  params: { clientId: string; resource: string },
  deps: AsterismDeps = {}
): Promise<TokenResponse> {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  if (!isPositiveFinite(dc.expires_in)) throw new AsterismError("invalid_response", "The sign-in code has an invalid lifetime");
  const deadline = now() + Math.min(dc.expires_in, MAX_DEVICE_CODE_LIFETIME_S) * 1000;
  let intervalMs = clampPollInterval(dc.interval) * 1000;

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
    } catch (err) {
      if (err instanceof NetworkError) continue; // DNS hiccup, reset connection, laptop suspend: keep trying until the code expires.
      throw err;
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
        intervalMs = Math.min(intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_S * 1000);
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
 * RFC 7009: asks asterism to revoke a refresh token (and the rest of its rotation chain). Returns
 * false without any request when the server advertises no revocation endpoint. Throws on failure;
 * callers that only want best effort catch it.
 */
export async function revokeRefreshToken(
  endpoints: AsterismEndpoints,
  params: { clientId: string; refreshToken: string },
  deps: AsterismDeps = {}
): Promise<boolean> {
  if (!endpoints.revocationEndpoint) return false;
  const r = await postForm(endpoints.revocationEndpoint, {
    token: params.refreshToken,
    token_type_hint: "refresh_token",
    client_id: params.clientId,
  }, deps);
  if (!r.ok) throw new AsterismError("server_error", `Revocation failed (status ${r.status})`);
  return true;
}

export type RegisterResult =
  | { ok: true; access_token: string; host: string }
  | { ok: false; message: string };

/**
 * `POST /api/executors/register`: presents an asterism access token to the relay to mint the
 * long-lived node or hub token. The node and hub CLIs both register through this one function so
 * the URL check, the refusal to follow redirects (which would carry the bearer token elsewhere)
 * and the handling of a failed or malformed response live in one place. Never throws; the
 * message is safe to print.
 */
export async function registerExecutor(
  relayUrl: string,
  accessToken: string,
  params: { type: "node" | "hub"; host: string },
  deps: AsterismDeps = {}
): Promise<RegisterResult> {
  let res: Response;
  try {
    assertSecureHttpUrl(relayUrl);
    res = await (deps.fetch ?? fetch)(`${relayUrl}/api/executors/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    return { ok: false, message: `Could not reach the relay to register: ${sanitizeForTerminal((err as Error).message)}` };
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  const field = (key: string): string | undefined => typeof body?.[key] === "string" && body[key] !== "" ? body[key] as string : undefined;
  const token = field("access_token");
  const host = field("host");
  if (!res.ok || !token || !host) {
    const reason = field("error_description") ?? field("error") ?? `status ${res.status}`;
    return { ok: false, message: `The relay refused the registration: ${sanitizeForTerminal(reason)}` };
  }
  return { ok: true, access_token: token, host };
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
