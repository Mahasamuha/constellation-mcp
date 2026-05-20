import * as client from "openid-client";
import { PrismaClient } from "./generated/prisma/client.js";
import { createLogger } from "@constellation/shared";
import { randomBytes } from "node:crypto";

const log = createLogger("oidc");

let _config: client.Configuration | null = null;

/**
 * Returns a cached OIDC client configuration, discovering the upstream provider
 * on first call. Requires OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET
 * environment variables.
 */
export async function getOidcConfig(): Promise<client.Configuration> {
  if (_config) return _config;

  const issuer = requireEnv("OIDC_ISSUER");
  const clientId = requireEnv("OIDC_CLIENT_ID");
  const clientSecret = requireEnv("OIDC_CLIENT_SECRET");

  _config = await client.discovery(new URL(issuer), clientId, clientSecret);
  log.info({ issuer }, "OIDC provider discovered");
  return _config;
}

/**
 * Builds the upstream OIDC authorization URL. Returns the URL to redirect the
 * user to, along with the state and optional PKCE verifier that must be stored
 * (e.g. in a short-lived session cookie) and passed to exchangeCodeAndUpsertUser
 * on callback.
 */
export async function buildAuthorizationUrl(
  redirectUri: string,
  usePkce = false
): Promise<{ url: URL; state: string; codeVerifier?: string }> {
  const config = await getOidcConfig();
  const state = randomBytes(16).toString("hex");

  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;

  if (usePkce) {
    codeVerifier = client.randomPKCECodeVerifier();
    codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  }

  const params: Record<string, string> = {
    redirect_uri: redirectUri,
    state,
    scope: "openid email profile",
  };

  if (codeChallenge) {
    params["code_challenge"] = codeChallenge;
    params["code_challenge_method"] = "S256";
  }

  const url = client.buildAuthorizationUrl(config, params);
  return { url, state, codeVerifier };
}

/**
 * Exchanges an upstream authorization code for user identity claims, then
 * upserts a `users` row keyed on (oidc_sub, oidc_issuer). Returns the user id.
 *
 * @param expectedState - the state value stored when the authorization URL was built
 * @param codeVerifier  - the PKCE verifier stored when the authorization URL was built, if PKCE was used
 */
export async function exchangeCodeAndUpsertUser(
  prisma: PrismaClient,
  callbackUrl: string,
  expectedState: string,
  codeVerifier?: string
): Promise<string> {
  const config = await getOidcConfig();
  const callbackUri = new URL(callbackUrl);

  const tokens = await client.authorizationCodeGrant(config, callbackUri, {
    expectedState,
    ...(codeVerifier ? { pkceCodeVerifier: codeVerifier } : {}),
  });

  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC token response contained no claims");

  const sub = claims.sub;
  const issuer = requireEnv("OIDC_ISSUER");
  const email = typeof claims.email === "string" ? claims.email : "";

  const user = await prisma.user.upsert({
    where: { oidcSub_oidcIssuer: { oidcSub: sub, oidcIssuer: issuer } },
    create: { oidcSub: sub, oidcIssuer: issuer, email },
    update: { email },
    select: { id: true, deactivatedAt: true },
  });

  if (user.deactivatedAt !== null) {
    throw new Error("Account is deactivated");
  }

  log.info({ userId: user.id }, "User upserted via OIDC");
  return user.id;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}
