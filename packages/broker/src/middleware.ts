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
 * Validates the Bearer token in the Authorization header against oauth_sessions.
 * Rejects if missing, expired, or the owning user is deactivated.
 * Attaches userId and sessionId to the request on success.
 */
export async function requireBearerAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);

  const session = await prisma.oauthSession.findUnique({
    where: { accessTokenHash: tokenHash },
    include: { user: { select: { id: true, deactivatedAt: true } } },
  });

  if (!session) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  if (session.expiresAt < new Date()) {
    res.status(401).json({ error: "invalid_token", error_description: "Token expired" });
    return;
  }

  if (session.user.deactivatedAt !== null) {
    res.status(401).json({ error: "invalid_token", error_description: "Account deactivated" });
    return;
  }

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
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);

  const session = await prisma.oauthSession.findUnique({
    where: { accessTokenHash: tokenHash },
    include: {
      user: { select: { id: true, deactivatedAt: true } },
      mcpClient: { select: { grantTypes: true } },
    },
  });

  if (!session) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  if (session.expiresAt < new Date()) {
    res.status(401).json({ error: "invalid_token", error_description: "Token expired" });
    return;
  }

  if (session.user.deactivatedAt !== null) {
    res.status(401).json({ error: "invalid_token", error_description: "Account deactivated" });
    return;
  }

  if (!session.mcpClient.grantTypes.includes("broker:manage")) {
    res.status(403).json({ error: "insufficient_scope", error_description: "broker:manage scope required" });
    return;
  }

  (req as AuthenticatedRequest).userId = session.user.id;
  (req as AuthenticatedRequest).sessionId = session.id;
  next();
}
