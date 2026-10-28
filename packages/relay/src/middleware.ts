import { Request, Response, NextFunction } from "express";
import {
  createVerifier,
  protectedResourceMetadataUrl,
  sendInsufficientScope,
  TokenValidationError,
  type Verifier,
  type VerifierConfig,
} from "@mahasamuha/asterism-verify";
import { requireEnv, groupsFromClaims, InvalidGroupsError, createLogger, clientIdFor } from "@constellation/shared";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { ADMIN_SCOPE, BASE_SCOPE, type RequestUser } from "./request-user.js";

const log = createLogger("middleware");

export interface AuthenticatedRequest extends Request {
  user: RequestUser;
}

/** The token audience: one token covers both /mcp and /api. Read lazily so importing needs no env. */
export function resourceAudience(): string {
  return `${requireEnv("RELAY_URL")}/mcp`;
}

function verifierConfig(): VerifierConfig {
  return { issuer: config.asterismIssuer, audience: resourceAudience() };
}

let verifier: Verifier | null = null;

/** The shared token verifier, created on first use (its JWKS cache is per instance). */
function getVerifier(): Verifier {
  verifier ??= createVerifier(verifierConfig());
  return verifier;
}

/** Test hook: substitute the verifier (pass null to restore lazy creation) and clear the known-users cache. */
export function setVerifierForTests(v: Verifier | null): void {
  verifier = v;
  knownUserIds.clear();
}

// Ids already known to have a users row, so a request is not a write. Bounded; the oldest
// entry is dropped first. A miss only costs one idempotent upsert.
const KNOWN_USERS_MAX = 10_000;
const knownUserIds = new Set<string>();

async function ensureUserRow(id: string): Promise<void> {
  if (knownUserIds.has(id)) return;
  await prisma.user.upsert({ where: { id }, create: { id }, update: {} });
  if (knownUserIds.size >= KNOWN_USERS_MAX) {
    const oldest = knownUserIds.values().next().value;
    if (oldest !== undefined) knownUserIds.delete(oldest);
  }
  knownUserIds.add(id);
}

/** Same challenge as asterism-verify's createBearerAuthMiddleware. */
function bearerChallenge(): string {
  const audience = resourceAudience();
  return `Bearer realm="${audience}", resource_metadata="${protectedResourceMetadataUrl(audience)}"`;
}

/**
 * Verifies the request's bearer token and returns the caller, or answers the request
 * (401 with a resource_metadata challenge, 503 on jwks_unavailable, 403 insufficient_scope
 * without the base scope) and returns null. Failures answer exactly as asterism-verify's
 * createBearerAuthMiddleware does.
 */
export async function authenticateRequest(req: Request, res: Response): Promise<RequestUser | null> {
  const authHeader = req.headers["authorization"];
  // The auth scheme is case-insensitive (RFC 7235 §2.1).
  if (!authHeader || !/^bearer /i.test(authHeader)) {
    res.set("WWW-Authenticate", bearerChallenge());
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return null;
  }

  let principal;
  try {
    principal = await getVerifier().verify(authHeader.slice("Bearer ".length));
  } catch (err) {
    if (err instanceof TokenValidationError && err.reason === "jwks_unavailable") {
      // The token wasn't proven bad; the signing keys couldn't be fetched. No challenge:
      // re-authenticating wouldn't help.
      res.set("Retry-After", "30");
      res.status(503).json({
        error: "temporarily_unavailable",
        error_description: "Token verification is temporarily unavailable",
      });
      return null;
    }
    res.set("WWW-Authenticate", `${bearerChallenge()}, error="invalid_token"`);
    res.status(401).json({ error: "invalid_token", error_description: "Bearer token is invalid or expired" });
    return null;
  }

  if (!principal.scopes.includes(BASE_SCOPE)) {
    sendInsufficientScope(res, verifierConfig(), [BASE_SCOPE], "The access token does not have the relay scope");
    return null;
  }

  let groups: string[];
  try {
    groups = groupsFromClaims(principal.claims);
  } catch (err) {
    if (!(err instanceof InvalidGroupsError)) throw err;
    // A malformed claim is an asterism or upstream problem; a new token won't fix it, so no
    // challenge. The claim value is not logged: it is attacker- or admin-controlled text.
    log.warn({ sub: principal.subject, clientId: principal.clientId }, "Refusing token with an invalid groups claim");
    res.status(403).json({
      error: "invalid_token_claims",
      error_description: "The access token's groups claim is malformed",
    });
    return null;
  }

  await ensureUserRow(principal.subject);

  return {
    id: principal.subject,
    clientId: principal.clientId,
    scopes: principal.scopes,
    groups,
    claims: principal.claims,
  };
}

export async function requireBearerAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  let user: RequestUser | null;
  try {
    user = await authenticateRequest(req, res);
  } catch (err) {
    log.error({ err }, "authentication failed unexpectedly");
    res.status(500).json({ error: "server_error" });
    return;
  }
  if (!user) return;
  (req as AuthenticatedRequest).user = user;
  next();
}

/** Answers 403 insufficient_scope asking for `scopes`, so the client can step up and retry. */
export function sendMissingScopes(res: Response, scopes: string[], description: string): void {
  sendInsufficientScope(res, verifierConfig(), scopes, description);
}

/**
 * Router-level guard for /api: only the Constellation CLI's client may call it. A token
 * issued to an MCP client (Claude.ai, ...) carries the `relay` scope too, but must never
 * change filters, revoke tokens or otherwise touch /api. Must run after requireBearerAuth.
 */
export function requireCliClient(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Partial<AuthenticatedRequest>).user;
  const expected = clientIdFor(requireEnv("RELAY_URL"), "cli");
  if (!user || user.clientId !== expected) {
    res.status(403).json({
      error: "invalid_client",
      error_description: "The /api routes accept only tokens issued to the Constellation CLI client",
    });
    return;
  }
  next();
}

/**
 * Requires the `admin` scope on the verified token AND membership of `config.adminGroup`
 * in its `groups`. Must run after requireBearerAuth.
 * The scope is asterism's short-lived step-up (5 minutes), so admin keeps that bound. The
 * group check means admin never depends on the asterism `requireGroups` policy for the
 * `admin` scope having been set. Stale `groups` (up to 24 hours) can only deny, never
 * grant, because the scope is required as well.
 * A missing scope answers 403 asking for both scopes, so the step-up token still works for
 * /api. A missing group answers a plain 403 with no challenge: stepping up cannot help.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Partial<AuthenticatedRequest>).user;
  if (!user) {
    res.set("WWW-Authenticate", bearerChallenge());
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return;
  }
  if (!user.scopes.includes(ADMIN_SCOPE)) {
    sendMissingScopes(res, [BASE_SCOPE, ADMIN_SCOPE], "Admin scope required");
    return;
  }
  if (!user.groups.includes(config.adminGroup)) {
    res.status(403).json({
      error: "forbidden",
      error_description: `This account is not in the admin group (${config.adminGroup})`,
    });
    return;
  }
  next();
}
