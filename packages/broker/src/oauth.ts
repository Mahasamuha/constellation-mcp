import { Router, Request, Response, IRouter } from "express";
import escHtml from "escape-html";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./db.js";
import { buildAuthorizationUrl, exchangeCodeAndUpsertUser } from "./oidc.js";
import { handleDeviceCodeGrant } from "./device.js";
import { generateToken, hashToken, safeEqual, createLogger } from "@constellation/shared";
import { checkBruteForce, recordFailure, validateLocalUser } from "./local-auth.js";

const log = createLogger("oauth");

export const oauthRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// /.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------

oauthRouter.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  const base = requireEnv("BROKER_URL");
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

oauthRouter.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  const base = requireEnv("BROKER_URL");

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
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
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

  // broker:manage is reserved for the first-party CLI client issued via the
  // device flow — strip it from any dynamically registered client.
  const grantTypes = (asStringArray(body["grant_types"]) || ["authorization_code"])
    .filter((g) => g !== "broker:manage");
  const tokenEndpointAuthMethod = typeof body["token_endpoint_auth_method"] === "string"
    ? body["token_endpoint_auth_method"]
    : "client_secret_basic";

  // Public clients (e.g. PKCE-only) send token_endpoint_auth_method=none
  const isPublic = tokenEndpointAuthMethod === "none";
  let clientSecret: string | undefined;
  let clientSecretHash: string | undefined;

  if (!isPublic) {
    clientSecret = generateToken();
    clientSecretHash = hashToken(clientSecret);
  }

  const oauthClient = await prisma.oauthClient.create({
    data: {
      redirectUris,
      grantTypes,
      isDynamic: true,
      clientSecretHash: clientSecretHash ?? null,
    },
    select: { id: true, createdAt: true },
  });

  log.info({ clientId: oauthClient.id }, "Dynamic client registered");

  const response: {
    client_id: string;
    client_id_issued_at: number;
    redirect_uris: string[];
    grant_types: string[];
    token_endpoint_auth_method: string;
    client_secret?: string;
  } = {
    client_id: oauthClient.id,
    client_id_issued_at: Math.floor(oauthClient.createdAt.getTime() / 1000),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };

  if (clientSecret) {
    response.client_secret = clientSecret;
  }

  res.status(201).json(response);
});

// ---------------------------------------------------------------------------
// GET /oauth/authorize
// ---------------------------------------------------------------------------

oauthRouter.get("/oauth/authorize", async (req: Request, res: Response) => {
  const { client_id, redirect_uri, code_challenge, response_type } = req.query as Record<string, string>;

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

  const oauthClient = await prisma.oauthClient.findUnique({ where: { id: client_id } });
  if (!oauthClient) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (!oauthClient.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered" });
    return;
  }

  if (process.env["AUTH_MODE"] === "local") {
    // Store OAuth params in a cookie; redirect to the local login form.
    const pendingId = randomBytes(16).toString("hex");
    res.cookie(`login_pending_${pendingId}`, JSON.stringify({
      clientId: client_id,
      redirectUri: redirect_uri,
      downstreamCodeChallenge: req.query["code_challenge"],
      downstreamCodeChallengeMethod: req.query["code_challenge_method"],
      downstreamState: req.query["state"],
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000,
      sameSite: "strict",
    });
    log.info({ clientId: client_id }, "Authorization redirected to local login");
    res.redirect(`/auth/login?pending=${pendingId}`);
    return;
  }

  // OIDC mode: redirect to upstream provider
  const usePkce = !!code_challenge;
  const callbackUrl = `${requireEnv("BROKER_URL")}/oauth/callback`;
  const { url, state, codeVerifier } = await buildAuthorizationUrl(callbackUrl, usePkce);

  // Store CSRF state and downstream client context in a short-lived signed cookie
  // so the callback handler can validate and complete the flow.
  const pendingId = randomBytes(16).toString("hex");

  res.cookie(`oidc_pending_${pendingId}`, JSON.stringify({
    state,
    codeVerifier,
    clientId: client_id,
    redirectUri: redirect_uri,
    // Carry the downstream client's PKCE challenge through so we can re-verify
    // it when issuing our own code to the MCP client.
    downstreamCodeChallenge: req.query["code_challenge"],
    downstreamCodeChallengeMethod: req.query["code_challenge_method"],
    downstreamState: req.query["state"],
  }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000, // 10 minutes
    sameSite: "lax",
  });

  // Embed pendingId in upstream state so callback can look up the cookie
  url.searchParams.set("state", `${state}:${pendingId}`);

  log.info({ clientId: client_id }, "Authorization redirected to upstream OIDC");
  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// GET /auth/login — local auth login form
// ---------------------------------------------------------------------------

oauthRouter.get("/auth/login", (req: Request, res: Response) => {
  const pendingId = typeof req.query["pending"] === "string" ? req.query["pending"] : "";
  res.send(loginPage(pendingId));
});

// ---------------------------------------------------------------------------
// POST /auth/login — local auth credential validation
// ---------------------------------------------------------------------------

interface LoginPending {
  clientId: string;
  redirectUri: string;
  downstreamCodeChallenge?: string;
  downstreamCodeChallengeMethod?: string;
  downstreamState?: string;
}

oauthRouter.post("/auth/login", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const pendingId = (body["pending"] ?? "").trim();
  const username = (body["username"] ?? "").trim();
  const password = body["password"] ?? "";

  const ip = req.ip ?? "unknown";
  if (!await checkBruteForce(ip)) {
    res.status(429).send(loginPage(pendingId, "Too many failed attempts. Please wait 15 minutes."));
    return;
  }

  const cookieName = `login_pending_${pendingId}`;
  const cookieVal = (req.cookies as Record<string, string>)[cookieName];
  if (!cookieVal) {
    res.status(400).send(loginPage("", "Login session expired. Please try again."));
    return;
  }

  let pending: LoginPending;
  try {
    pending = JSON.parse(cookieVal) as LoginPending;
  } catch {
    res.status(400).send(loginPage("", "Malformed login session."));
    return;
  }

  let userId: string;
  try {
    userId = await validateLocalUser(username, password);
  } catch {
    await recordFailure(ip);
    res.send(loginPage(pendingId, "Invalid username or password."));
    return;
  }

  res.clearCookie(cookieName);

  const code = generateToken();
  await prisma.authCode.create({
    data: {
      codeHash: hashToken(code),
      userId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.downstreamCodeChallenge ?? null,
      codeChallengeMethod: pending.downstreamCodeChallengeMethod ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  const redirectParams = new URLSearchParams({ code });
  if (pending.downstreamState) redirectParams.set("state", pending.downstreamState);

  log.info({ userId, clientId: pending.clientId }, "Authorization code issued (local auth)");
  res.redirect(`${pending.redirectUri}?${redirectParams.toString()}`);
});

// ---------------------------------------------------------------------------
// GET /oauth/callback — upstream OIDC callback
// ---------------------------------------------------------------------------

interface PendingOidc {
  state: string;
  codeVerifier?: string;
  clientId: string;
  redirectUri: string;
  downstreamCodeChallenge?: string;
  downstreamCodeChallengeMethod?: string;
  downstreamState?: string;
}

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
  const cookieName = `oidc_pending_${pendingId}`;
  const cookieVal = (req.cookies as Record<string, string>)[cookieName];

  if (!cookieVal) {
    res.status(400).send("Authorization session expired or not found");
    return;
  }

  res.clearCookie(cookieName);

  let pending: PendingOidc;
  try {
    pending = JSON.parse(cookieVal) as PendingOidc;
  } catch {
    res.status(400).send("Malformed authorization session");
    return;
  }

  if (pending.state !== upstreamState) {
    res.status(400).send("State mismatch");
    return;
  }

  // Reconstruct the full callback URL (including query params) for the token exchange.
  const callbackUrl = `${requireEnv("BROKER_URL")}/oauth/callback?${new URLSearchParams(req.query as Record<string, string>).toString()}`;

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

  // Issue a short-lived authorization code to hand back to the MCP client.
  const code = generateToken();
  await prisma.authCode.create({
    data: {
      codeHash: hashToken(code),
      userId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.downstreamCodeChallenge ?? null,
      codeChallengeMethod: pending.downstreamCodeChallengeMethod ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  const redirectParams = new URLSearchParams({ code });
  if (pending.downstreamState) redirectParams.set("state", pending.downstreamState);

  log.info({ userId, clientId: pending.clientId }, "Authorization code issued");
  res.redirect(`${pending.redirectUri}?${redirectParams.toString()}`);
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

  // Verify PKCE if the authorization request included a code_challenge.
  if (entry.codeChallenge) {
    if (!code_verifier) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const method = entry.codeChallengeMethod ?? "S256";
    if (method !== "S256") {
      res.status(400).json({ error: "invalid_grant", error_description: "Unsupported code_challenge_method" });
      return;
    }
    const challenge = createHash("sha256").update(code_verifier).digest("base64url");
    if (challenge !== entry.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }
  }

  await prisma.authCode.delete({ where: { codeHash } });

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

  const accessToken = generateToken();
  const accessTokenHash = hashToken(accessToken);
  const refreshToken = generateToken();
  const refreshTokenHash = hashToken(refreshToken);

  const accessTtlHours = parseInt(process.env["OAUTH_ACCESS_TOKEN_TTL_HOURS"] ?? "24", 10);
  const refreshTtlDays = parseInt(process.env["OAUTH_REFRESH_TOKEN_TTL_DAYS"] ?? "30", 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + accessTtlHours * 3600 * 1000);
  const refreshExpiresAt = new Date(now.getTime() + refreshTtlDays * 86400 * 1000);

  await prisma.oauthSession.create({
    data: {
      userId: entry.userId,
      mcpClientId: client_id,
      accessTokenHash,
      expiresAt,
      refreshTokenHash,
      refreshTokenExpiresAt: refreshExpiresAt,
    },
  });

  log.info({ userId: entry.userId, clientId: client_id }, "Access token issued (authorization_code)");

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTtlHours * 3600,
    refresh_token: refreshToken,
  });
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

  const accessToken = generateToken();
  const accessTokenHash = hashToken(accessToken);
  const newRefreshToken = generateToken();
  const newRefreshTokenHash = hashToken(newRefreshToken);

  const accessTtlHours = parseInt(process.env["OAUTH_ACCESS_TOKEN_TTL_HOURS"] ?? "24", 10);
  const refreshTtlDays = parseInt(process.env["OAUTH_REFRESH_TOKEN_TTL_DAYS"] ?? "30", 10);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + accessTtlHours * 3600 * 1000);
  const refreshExpiresAt = new Date(now.getTime() + refreshTtlDays * 86400 * 1000);

  await prisma.oauthSession.update({
    where: { id: session.id },
    data: {
      accessTokenHash,
      expiresAt,
      refreshTokenHash: newRefreshTokenHash,
      refreshTokenExpiresAt: refreshExpiresAt,
    },
  });

  log.info({ userId: session.userId, clientId: client_id }, "Access token issued (refresh_token)");

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessTtlHours * 3600,
    refresh_token: newRefreshToken,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function loginPage(pendingId: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Sign in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 4rem 1rem; }
  .card { background: #fff; border-radius: 8px; padding: 2rem; max-width: 380px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  h1 { margin-top: 0; font-size: 1.4rem; }
  label { display: block; margin: 1rem 0 .4rem; font-weight: 500; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
  button { margin-top: 1.2rem; padding: .6rem 1.4rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; background: #2563eb; color: #fff; }
  .error { color: #dc2626; background: #fee2e2; padding: .6rem; border-radius: 4px; margin-bottom: .5rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="POST" action="/auth/login">
      <input type="hidden" name="pending" value="${escHtml(pendingId)}">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}


/**
 * Rejects javascript:, data:, and vbscript: URIs. Allows https:, custom schemes
 * (native app callbacks), and http: only for loopback addresses.
 */
function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const scheme = parsed.protocol;
  if (scheme === "javascript:" || scheme === "data:" || scheme === "vbscript:") return false;
  if (scheme === "http:") {
    // Allow http only for loopback — native app dev servers on localhost.
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  }
  return true;
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  if (typeof val === "string") return [val];
  return [];
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}
