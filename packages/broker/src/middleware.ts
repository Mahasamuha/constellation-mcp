import { Request, Response, NextFunction } from "express";
import { prisma } from "./db.js";
import { hashToken, safeEqual } from "@constellation/shared";

/**
 * Validates the CSRF token in the request body against the named cookie.
 * Returns true if valid, false if missing or mismatched.
 * Caller is responsible for clearing the cookie on success.
 */
export function verifyCsrfToken(req: Request, cookieName: string): boolean {
  const cookie = (req.cookies as Record<string, string>)[cookieName];
  const body = (req.body as Record<string, string>)["csrf_token"] ?? "";
  if (!cookie) return false;
  return safeEqual(cookie, body);
}

export interface AuthenticatedRequest extends Request {
  userId: string;
  sessionId: string;
}

/**
 * Resolves the Bearer token from the Authorization header, validates it against
 * oauth_sessions, and checks expiry and account status. Returns the session on
 * success or writes a 401 response and returns null.
 */
async function resolveSession(req: Request, res: Response, includeClient: boolean) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return null;
  }

  const tokenHash = hashToken(authHeader.slice(7));

  const session = await prisma.oauthSession.findUnique({
    where: { accessTokenHash: tokenHash },
    include: {
      user: { select: { id: true, deactivatedAt: true } },
      ...(includeClient ? { mcpClient: { select: { grantTypes: true } } } : {}),
    },
  });

  if (!session) {
    res.status(401).json({ error: "invalid_token" });
    return null;
  }

  if (session.expiresAt < new Date()) {
    res.status(401).json({ error: "invalid_token", error_description: "Token expired" });
    return null;
  }

  if (session.user.deactivatedAt !== null) {
    res.status(401).json({ error: "invalid_token", error_description: "Account deactivated" });
    return null;
  }

  return session;
}

/**
 * Validates the Bearer token in the Authorization header against oauth_sessions.
 * Rejects if missing, expired, or the owning user is deactivated.
 * Attaches userId and sessionId to the request on success.
 */
export async function requireBearerAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const session = await resolveSession(req, res, false);
  if (!session) return;

  (req as AuthenticatedRequest).userId = session.user.id;
  (req as AuthenticatedRequest).sessionId = session.id;
  next();
}

/**
 * Extends requireBearerAuth with a broker:manage scope check.
 * The session's OAuth client must have "broker:manage" in its grant_types.
 */
export async function requireBrokerManage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const session = await resolveSession(req, res, true);
  if (!session) return;

  const client = (session as typeof session & { mcpClient: { grantTypes: string[] } }).mcpClient;
  if (!client.grantTypes.includes("broker:manage")) {
    res.status(403).json({ error: "insufficient_scope", error_description: "broker:manage scope required" });
    return;
  }

  (req as AuthenticatedRequest).userId = session.user.id;
  (req as AuthenticatedRequest).sessionId = session.id;
  next();
}
