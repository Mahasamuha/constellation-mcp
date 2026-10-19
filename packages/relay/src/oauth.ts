import { Router, Request, Response, IRouter } from "express";
import { Prisma } from "./generated/prisma/client.js";
import { createHash } from "node:crypto";
import { prisma } from "./db.js";
import { buildAuthorizationUrl, exchangeCodeAndUpsertUser } from "./oidc.js";
import { handleDeviceCodeGrant } from "./device.js";
import { generateToken, hashToken, safeEqual, createLogger, requireEnv } from "@constellation/shared";
import { checkBruteForce, recordFailure, validateLocalUser } from "./local-auth.js";
import { config } from "./config.js";
import { issueOAuthSession, makeTokenPair, sendTokenResponse } from "./oauth-tokens.js";
import {
  clientDisclosure,
  DEFAULT_GRANT_TYPES,
  InvalidClientError,
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
  resolveOauthClient,
  SUPPORTED_GRANT_TYPES,
  type ClientDisclosure,
} from "./oauth-clients.js";
import { authorizeConsentPage, loginPage } from "./oauth-pages.js";
import { clearFlowCookie, FLOW_COOKIE_TTL_MS, readFlowCookie, setFlowCookie, takeFlowCookie } from "./oauth-flow-cookies.js";

const log = createLogger("oauth");

export const oauthRouter: IRouter = Router();

/** What the downstream MCP client asked for at /oauth/authorize, carried through the
 * pending-flow cookies until an auth code is issued. */
interface DownstreamAuthRequest {
  clientId: string;
  /** As requested (for loopback clients this carries the actual port, not the registered one). */
  redirectUri: string;
  downstreamCodeChallenge: string;
  /** S256 only; /oauth/authorize rejects anything else. */
  downstreamCodeChallengeMethod: "S256";
  downstreamState?: string;
}

interface AuthorizePending extends DownstreamAuthRequest {
  csrfToken: string;
}

interface PendingOidc extends DownstreamAuthRequest {
  state: string;
  codeVerifier?: string;
}

// Runtime shape guards for the signed flow cookies: a missing or malformed field becomes
// a 400 at the caller rather than a TypeError (e.g. safeEqual on undefined) deeper in.
function isDownstreamAuthRequest(v: unknown): v is DownstreamAuthRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["clientId"] === "string"
    && typeof o["redirectUri"] === "string"
    && typeof o["downstreamCodeChallenge"] === "string"
    && o["downstreamCodeChallengeMethod"] === "S256"
    && (o["downstreamState"] === undefined || typeof o["downstreamState"] === "string");
}

function isAuthorizePending(v: unknown): v is AuthorizePending {
  return isDownstreamAuthRequest(v) && typeof (v as unknown as Record<string, unknown>)["csrfToken"] === "string";
}

function isPendingOidc(v: unknown): v is PendingOidc {
  if (!isDownstreamAuthRequest(v)) return false;
  const o = v as unknown as Record<string, unknown>;
  return typeof o["state"] === "string" && (o["codeVerifier"] === undefined || typeof o["codeVerifier"] === "string");
}

// ---------------------------------------------------------------------------
// /.well-known — OAuth discovery metadata
// ---------------------------------------------------------------------------

// Root document kept for older clients that probe it directly. Clients that arrive via
// the WWW-Authenticate challenge get the /mcp variant below (RFC 9728 §3.3: `resource`
// must equal the URL the client requested).
oauthRouter.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  const base = requireEnv("RELAY_URL");
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

oauthRouter.get("/.well-known/oauth-protected-resource/mcp", (_req: Request, res: Response) => {
  const base = requireEnv("RELAY_URL");
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

oauthRouter.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  const base = requireEnv("RELAY_URL");

  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    device_authorization_endpoint: `${base}/oauth/device/code`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  });
});

// ---------------------------------------------------------------------------
// POST /oauth/register — Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

oauthRouter.post("/oauth/register", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const redirectUris = asStringArray(body["redirect_uris"]);
  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    return;
  }

  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: `redirect_uri not allowed: ${uri}` });
      return;
    }
  }

  // grantTypes is informational: it is stored and echoed, but not enforced at the token
  // endpoint beyond which grants the endpoint supports at all. Unsupported values are
  // rejected rather than silently dropped so the client learns what it actually got.
  const grantTypesRaw = asStringArray(body["grant_types"]);
  const unsupportedGrants = grantTypesRaw.filter((g) => !SUPPORTED_GRANT_TYPES.includes(g));
  if (unsupportedGrants.length > 0) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: `unsupported grant_types: ${unsupportedGrants.join(", ")}`,
    });
    return;
  }
  const grantTypes = grantTypesRaw.length > 0 ? grantTypesRaw : DEFAULT_GRANT_TYPES;

  // Dynamic registration is public-client only (PKCE, no secret). Issuing secrets would
  // oblige the token endpoint to support client_secret_basic (RFC 6749 §2.3.1). An omitted
  // method is replaced with "none" rather than the RFC 7591 client_secret_basic default,
  // which §3.2.1 permits since the response states the value the client must use.
  const requestedAuthMethod = body["token_endpoint_auth_method"];
  if (requestedAuthMethod !== undefined && requestedAuthMethod !== "none") {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: "token_endpoint_auth_method must be \"none\"; only public clients may register dynamically",
    });
    return;
  }

  const oauthClient = await prisma.oauthClient.create({
    data: {
      redirectUris,
      grantTypes,
      isDynamic: true,
      clientSecretHash: null,
    },
    select: { id: true, createdAt: true },
  });

  log.info({ clientId: oauthClient.id }, "Dynamic client registered");

  res.status(201).json({
    client_id: oauthClient.id,
    client_id_issued_at: Math.floor(oauthClient.createdAt.getTime() / 1000),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: "none",
  });
});

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_STATE_LENGTH = 512;

oauthRouter.get("/oauth/authorize", async (req: Request, res: Response) => {
  // Repeated query params parse to arrays (and bracket syntax to objects); every
  // parameter is single-valued, so anything but a string is malformed.
  const q = req.query;
  for (const key of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state"]) {
    if (q[key] !== undefined && typeof q[key] !== "string") {
      res.status(400).json({ error: "invalid_request", error_description: `${key} must be a single string` });
      return;
    }
  }
  const { client_id, redirect_uri, code_challenge, code_challenge_method, response_type, state } =
    q as Record<string, string | undefined>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (!client_id || !redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "client_id and redirect_uri are required" });
    return;
  }

  if (!code_challenge) {
    res.status(400).json({ error: "invalid_request", error_description: "code_challenge is required (PKCE S256)" });
    return;
  }
  // S256 is the only method advertised in the discovery metadata; "plain" and an absent
  // method (which RFC 7636 would default to plain) are both refused.
  if (code_challenge_method !== "S256") {
    res.status(400).json({ error: "invalid_request", error_description: "code_challenge_method must be S256" });
    return;
  }
  if (!CODE_CHALLENGE_PATTERN.test(code_challenge)) {
    res.status(400).json({ error: "invalid_request", error_description: "code_challenge is not a valid S256 challenge" });
    return;
  }
  if (state !== undefined && state.length > MAX_STATE_LENGTH) {
    res.status(400).json({ error: "invalid_request", error_description: `state exceeds ${MAX_STATE_LENGTH} characters` });
    return;
  }

  let oauthClient;
  try {
    oauthClient = await resolveOauthClient(client_id);
  } catch (err) {
    if (err instanceof InvalidClientError) {
      res.status(400).json({ error: "invalid_client", error_description: err.message });
      return;
    }
    throw err;
  }
  if (!oauthClient) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (!isRegisteredRedirectUri(oauthClient.redirectUris, redirect_uri)) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered" });
    return;
  }

  // The redirect_uri as requested is what's stored, so the token endpoint's exact
  // comparison sees the same value (including a loopback client's actual port).
  const request: DownstreamAuthRequest = {
    clientId: client_id,
    redirectUri: redirect_uri,
    downstreamCodeChallenge: code_challenge,
    downstreamCodeChallengeMethod: code_challenge_method,
    ...(state !== undefined && { downstreamState: state }),
  };
  const disclosure = clientDisclosure(oauthClient, redirect_uri);

  if (config.authMode === "local") {
    // Render the login form directly rather than redirecting to /auth/login: the
    // SameSite=Strict login_pending cookie isn't sent on a redirect that follows a
    // cross-site-initiated navigation, so GET /auth/login couldn't show the disclosure.
    const pendingId = setFlowCookie(res, "login_pending", request);
    log.info({ clientId: client_id }, "Authorization started (local login)");
    sendPage(res, loginPage(pendingId, undefined, disclosure));
    return;
  }

  // OIDC mode: the upstream provider shows nothing about the MCP client, so the relay
  // renders its own consent interstitial first — the MCP spec requires the redirect
  // hostname to be displayed during authorization.
  const csrfToken = generateToken();
  const pending: AuthorizePending = { ...request, csrfToken };
  const pendingId = setFlowCookie(res, "authz_pending", pending);
  sendPage(res, authorizeConsentPage(pendingId, csrfToken, disclosure));
});

// ---------------------------------------------------------------------------
// POST /oauth/authorize/consent — OIDC-mode consent interstitial submission
// ---------------------------------------------------------------------------

oauthRouter.post("/oauth/authorize/consent", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const pending = takeFlowCookie(req, res, "authz_pending", formString(body, "pending"), isAuthorizePending);
  if (!pending) {
    res.status(400).send("Authorization session expired or not found");
    return;
  }

  if (!safeEqual(pending.csrfToken, formString(body, "csrf_token"))) {
    res.status(403).send("Invalid or missing CSRF token. Please go back and try again.");
    return;
  }

  if (formString(body, "action") !== "approve") {
    // redirectUri was validated against the client's registered URIs at /oauth/authorize.
    const params: Record<string, string> = { error: "access_denied" };
    if (pending.downstreamState) params["state"] = pending.downstreamState;
    log.info({ clientId: pending.clientId }, "Authorization denied at consent");
    res.redirect(withQueryParams(pending.redirectUri, params));
    return;
  }

  await redirectToUpstreamOidc(pending, res);
});

async function redirectToUpstreamOidc(pending: DownstreamAuthRequest, res: Response): Promise<void> {
  const callbackUrl = `${requireEnv("RELAY_URL")}/oauth/callback`;
  const { url, state, codeVerifier } = await buildAuthorizationUrl(callbackUrl, true);

  // Store CSRF state and downstream client context in a short-lived signed cookie
  // so the callback handler can validate and complete the flow. Fields are copied
  // explicitly so the consent page's CSRF token doesn't ride along.
  const oidcPending: PendingOidc = {
    state,
    codeVerifier,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    // Carry the downstream client's PKCE challenge through so we can re-verify
    // it when issuing our own code to the MCP client.
    downstreamCodeChallenge: pending.downstreamCodeChallenge,
    downstreamCodeChallengeMethod: pending.downstreamCodeChallengeMethod,
    downstreamState: pending.downstreamState,
  };
  const pendingId = setFlowCookie(res, "oidc_pending", oidcPending);

  // Embed pendingId in upstream state so callback can look up the cookie
  url.searchParams.set("state", `${state}:${pendingId}`);

  log.info({ clientId: pending.clientId }, "Authorization redirected to upstream OIDC");
  res.redirect(url.toString());
}

// ---------------------------------------------------------------------------
// /auth/login — local auth login form
// ---------------------------------------------------------------------------

/** Client disclosure for a login re-render. Best effort: a DB failure logs and shows the form without it. */
async function loginDisclosure(pending: DownstreamAuthRequest | undefined): Promise<ClientDisclosure | undefined> {
  if (!pending) return undefined;
  try {
    const client = await prisma.oauthClient.findUnique({
      where: { id: pending.clientId },
      select: { id: true, clientName: true, isMetadataDocument: true },
    });
    return client ? clientDisclosure(client, pending.redirectUri) : undefined;
  } catch (err) {
    log.warn({ err, clientId: pending.clientId }, "Failed to load client disclosure for login page");
    return undefined;
  }
}

// /oauth/authorize renders the login form itself; this route remains for existing links.
oauthRouter.get("/auth/login", async (req: Request, res: Response) => {
  const pendingId = typeof req.query["pending"] === "string" ? req.query["pending"] : "";
  const pending = readFlowCookie(req, "login_pending", pendingId, isDownstreamAuthRequest);
  sendPage(res, loginPage(pendingId, undefined, await loginDisclosure(pending)));
});

// ---------------------------------------------------------------------------
// POST /auth/login — local auth credential validation
// ---------------------------------------------------------------------------

oauthRouter.post("/auth/login", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const pendingId = formString(body, "pending").trim();
  const username = formString(body, "username").trim();
  const password = formString(body, "password");

  // Read (not consume) so a failed attempt can retry against the same flow.
  const pending = readFlowCookie(req, "login_pending", pendingId, isDownstreamAuthRequest);

  const ip = req.ip ?? "unknown";
  if (!await checkBruteForce(ip)) {
    sendPage(res, loginPage(pendingId, "Too many failed attempts. Please wait 15 minutes.", await loginDisclosure(pending)), 429);
    return;
  }

  if (!pending) {
    sendPage(res, loginPage("", "Login session expired. Please try again."), 400);
    return;
  }

  let userId: string;
  try {
    userId = await validateLocalUser(username, password);
  } catch {
    await recordFailure(ip);
    sendPage(res, loginPage(pendingId, "Invalid username or password.", await loginDisclosure(pending)));
    return;
  }

  clearFlowCookie(res, "login_pending", pendingId);

  log.info({ userId, clientId: pending.clientId }, "Authorization code issued (local auth)");
  await issueAuthCode(pending, userId, res);
});

// ---------------------------------------------------------------------------
// GET /oauth/callback — upstream OIDC callback
// ---------------------------------------------------------------------------

/** Removes expired auth code rows. Called periodically from index.ts. */
export async function pruneAuthCodes(): Promise<void> {
  await prisma.authCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

oauthRouter.get("/oauth/callback", async (req: Request, res: Response) => {
  const rawState = typeof req.query["state"] === "string" ? req.query["state"] : "";
  const colonIdx = rawState.lastIndexOf(":");
  if (colonIdx === -1) {
    res.status(400).send("Invalid state parameter");
    return;
  }

  const upstreamState = rawState.slice(0, colonIdx);
  const pendingId = rawState.slice(colonIdx + 1);
  const pending = takeFlowCookie(req, res, "oidc_pending", pendingId, isPendingOidc);

  if (!pending) {
    res.status(400).send("Authorization session expired or not found");
    return;
  }

  if (pending.state !== upstreamState) {
    res.status(400).send("State mismatch");
    return;
  }

  // Reconstruct the full callback URL (including query params) for the token exchange.
  const callbackUrl = `${requireEnv("RELAY_URL")}/oauth/callback?${new URLSearchParams(req.query as Record<string, string>).toString()}`;

  let userId: string;
  try {
    userId = await exchangeCodeAndUpsertUser(
      prisma,
      callbackUrl,
      rawState,
      pending.codeVerifier
    );
  } catch (err) {
    log.warn({ err }, "OIDC code exchange failed");
    res.status(400).send("Authentication failed");
    return;
  }

  log.info({ userId, clientId: pending.clientId }, "Authorization code issued");
  await issueAuthCode(pending, userId, res);
});

// ---------------------------------------------------------------------------
// POST /oauth/token
// ---------------------------------------------------------------------------

oauthRouter.post("/oauth/token", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const grantType = body["grant_type"];

  if (grantType === "authorization_code") {
    await handleAuthorizationCodeGrant(body, res);
  } else if (grantType === "refresh_token") {
    await handleRefreshTokenGrant(body, res);
  } else if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
    await handleDeviceCodeGrant(body, res);
  } else {
    res.status(400).json({ error: "unsupported_grant_type" });
  }
});

async function handleAuthorizationCodeGrant(
  body: Record<string, string>,
  res: Response
): Promise<void> {
  const { code, redirect_uri, client_id, code_verifier } = body;

  if (!code || !redirect_uri || !client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "code, redirect_uri, and client_id are required" });
    return;
  }

  const codeHash = hashToken(code);
  const entry = await prisma.authCode.findUnique({ where: { codeHash } });
  if (!entry || entry.expiresAt < new Date()) {
    if (entry) await prisma.authCode.delete({ where: { codeHash } });
    res.status(400).json({ error: "invalid_grant", error_description: "Authorization code invalid or expired" });
    return;
  }

  if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
    await prisma.authCode.delete({ where: { codeHash } });
    res.status(400).json({ error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" });
    return;
  }

  // PKCE is mandatory for every AuthCode — code_challenge is required at
  // /oauth/authorize, and the column itself is NOT NULL — so this runs
  // unconditionally rather than only "if present". A future code path that
  // creates an AuthCode without going through /oauth/authorize fails at the
  // database layer; it can't reach here with a missing challenge.
  if (!code_verifier) {
    res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
    return;
  }
  if (entry.codeChallengeMethod !== "S256") {
    res.status(400).json({ error: "invalid_grant", error_description: "Unsupported code_challenge_method" });
    return;
  }
  const challenge = createHash("sha256").update(code_verifier).digest("base64url");
  if (challenge !== entry.codeChallenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
    return;
  }

  // Look up the OAuth client and verify client_secret BEFORE consuming the code.
  // Doing it after would let an attacker who intercepts a code submit it with a wrong
  // secret — the code is consumed but no token issued, so the legitimate client's code
  // is gone (targeted DoS).
  const oauthClient = await prisma.oauthClient.findUnique({ where: { id: client_id } });
  if (!oauthClient) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (oauthClient.clientSecretHash !== null) {
    const { client_secret } = body;
    if (!client_secret || !safeEqual(hashToken(client_secret), oauthClient.clientSecretHash)) {
      res.status(401).json({ error: "invalid_client", error_description: "client_secret required for confidential clients" });
      return;
    }
  }

  try {
    await prisma.authCode.delete({ where: { codeHash } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code already redeemed" });
      return;
    }
    throw err;
  }

  const tokens = await issueOAuthSession(entry.userId, client_id);

  log.info({ userId: entry.userId, clientId: client_id }, "Access token issued (authorization_code)");
  sendTokenResponse(res, tokens);
}

async function handleRefreshTokenGrant(
  body: Record<string, string>,
  res: Response
): Promise<void> {
  const { refresh_token, client_id } = body;

  if (!refresh_token || !client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "refresh_token and client_id are required" });
    return;
  }

  const refreshTokenHash = hashToken(refresh_token);
  const session = await prisma.oauthSession.findUnique({
    where: { refreshTokenHash },
    include: { user: { select: { id: true, deactivatedAt: true } } },
  });

  if (!session || session.mcpClientId !== client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token invalid" });
    return;
  }

  if (!session.refreshTokenExpiresAt || session.refreshTokenExpiresAt < new Date()) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
    return;
  }

  if (session.user.deactivatedAt !== null) {
    res.status(400).json({ error: "invalid_grant", error_description: "Account is deactivated" });
    return;
  }

  const oauthClient = await prisma.oauthClient.findUnique({ where: { id: client_id } });
  if (!oauthClient) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (oauthClient.clientSecretHash !== null) {
    const { client_secret } = body;
    if (!client_secret || !safeEqual(hashToken(client_secret), oauthClient.clientSecretHash)) {
      res.status(401).json({ error: "invalid_client", error_description: "client_secret required for confidential clients" });
      return;
    }
  }

  const tokens = makeTokenPair();

  // Conditional on the presented refresh token still being current, so two concurrent
  // refreshes can't both succeed and mint two live token pairs from one token.
  const rotated = await prisma.oauthSession.updateMany({
    where: { id: session.id, refreshTokenHash },
    data: {
      accessTokenHash: tokens.accessTokenHash,
      expiresAt: tokens.expiresAt,
      refreshTokenHash: tokens.refreshTokenHash,
      refreshTokenExpiresAt: tokens.refreshExpiresAt,
    },
  });
  if (rotated.count === 0) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token invalid" });
    return;
  }

  log.info({ userId: session.userId, clientId: client_id }, "Access token issued (refresh_token)");
  sendTokenResponse(res, tokens);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Appends params to a redirect URI, preserving any query it already has. */
function withQueryParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  if (typeof val === "string") return [val];
  return [];
}

/** A form field as a string; absent or non-string (e.g. repeated fields parse to arrays) becomes "". */
function formString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : "";
}

/** Login and consent pages carry per-flow state, so they must never be cached. */
function sendPage(res: Response, html: string, status = 200): void {
  res.status(status).set("Cache-Control", "no-store").send(html);
}

async function issueAuthCode(pending: DownstreamAuthRequest, userId: string, res: Response): Promise<void> {
  const code = generateToken();
  await prisma.authCode.create({
    data: {
      codeHash: hashToken(code),
      userId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.downstreamCodeChallenge,
      codeChallengeMethod: pending.downstreamCodeChallengeMethod,
      expiresAt: new Date(Date.now() + FLOW_COOKIE_TTL_MS),
    },
  });
  const redirectParams: Record<string, string> = { code };
  if (pending.downstreamState) redirectParams["state"] = pending.downstreamState;
  res.redirect(withQueryParams(pending.redirectUri, redirectParams));
}
