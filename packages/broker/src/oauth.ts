import { Router, Request, Response, IRouter } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";
import { buildAuthorizationUrl } from "./oidc.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("oauth");

export const oauthRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// /.well-known/oauth-authorization-server
// ---------------------------------------------------------------------------

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

  const grantTypes = asStringArray(body["grant_types"]) || ["authorization_code"];
  const tokenEndpointAuthMethod = typeof body["token_endpoint_auth_method"] === "string"
    ? body["token_endpoint_auth_method"]
    : "client_secret_basic";

  // Public clients (e.g. PKCE-only) send token_endpoint_auth_method=none
  const isPublic = tokenEndpointAuthMethod === "none";
  let clientSecret: string | undefined;
  let clientSecretHash: string | undefined;

  if (!isPublic) {
    const { generateToken, hashToken } = await import("@constellation/shared");
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

  const response: Record<string, unknown> = {
    client_id: oauthClient.id,
    client_id_issued_at: Math.floor(oauthClient.createdAt.getTime() / 1000),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };

  if (clientSecret) {
    response["client_secret"] = clientSecret;
  }

  res.status(201).json(response);
});

// ---------------------------------------------------------------------------
// GET /oauth/authorize — redirect to upstream OIDC provider
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

  const oauthClient = await prisma.oauthClient.findUnique({ where: { id: client_id } });
  if (!oauthClient) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }

  if (!oauthClient.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered" });
    return;
  }

  // PKCE is used when the client sends a code_challenge; use plain redirect otherwise
  const usePkce = !!code_challenge;
  const callbackUrl = `${requireEnv("BROKER_URL")}/oauth/callback`;
  const { url, state, codeVerifier } = await buildAuthorizationUrl(callbackUrl, usePkce);

  // Store CSRF state and downstream client context in a short-lived signed cookie
  // so the callback handler can validate and complete the flow.
  const pendingId = randomBytes(16).toString("hex");
  (req as Request & { session?: Record<string, unknown> });

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
// helpers
// ---------------------------------------------------------------------------

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
