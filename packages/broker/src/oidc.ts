import * as client from "openid-client";
import { PrismaClient, Prisma } from "./generated/prisma/client.js";
import { createLogger, requireEnv } from "@constellation/shared";
import { randomBytes } from "node:crypto";

const log = createLogger("oidc");

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

let _config: client.Configuration | null = null;
let _configFetchedAt = 0;

/**
 * Returns a cached OIDC client configuration, discovering the upstream provider
 * on first call and refreshing every 24 hours. Falls back to a stale config if
 * re-discovery fails so transient provider outages don't break in-flight flows.
 * Requires OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET env vars.
 */
export async function getOidcConfig(): Promise<client.Configuration> {
  if (_config && Date.now() - _configFetchedAt < DISCOVERY_TTL_MS) return _config;

  const issuer = requireEnv("OIDC_ISSUER");
  const clientId = requireEnv("OIDC_CLIENT_ID");
  const clientSecret = requireEnv("OIDC_CLIENT_SECRET");

  try {
    _config = await client.discovery(new URL(issuer), clientId, clientSecret);
    _configFetchedAt = Date.now();
    log.info({ issuer }, "OIDC provider discovered");
  } catch (err) {
    if (_config) {
      log.warn({ err, issuer }, "OIDC re-discovery failed, using stale config");
    } else {
      throw err;
    }
  }

  return _config!;
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

  // Store claims for RPC envelope forwarding — strip JWT-internal fields.
  const claimsToStore = Object.fromEntries(
    Object.entries(claims as Record<string, unknown>).filter(
      ([k]) => !["iat", "exp", "nbf", "nonce", "at_hash", "c_hash", "auth_time"].includes(k)
    )
  );

  const user = await prisma.user.upsert({
    where: { oidcSub_oidcIssuer: { oidcSub: sub, oidcIssuer: issuer } },
    create: { oidcSub: sub, oidcIssuer: issuer, email, lastKnownClaims: claimsToStore as Prisma.InputJsonObject },
    update: { email, lastKnownClaims: claimsToStore as Prisma.InputJsonObject },
    select: { id: true, deactivatedAt: true },
  });

  if (user.deactivatedAt !== null) {
    throw new Error("Account is deactivated");
  }

  log.info({ userId: user.id }, "User upserted via OIDC");
  return user.id;
}

