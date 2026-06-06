import { Request, Response, NextFunction } from "express";
import { prisma } from "./db.js";
import { hashToken, safeEqual } from "@constellation/shared";

export async function lookupOAuthSession(token: string): Promise<{
  id: string;
  expiresAt: Date;
  mcpClientId: string;
  userId: string;
  oidcSub: string | null;
  lastKnownClaims: Record<string, unknown> | null;
} | null> {
  const session = await prisma.oauthSession.findUnique({
    where: { accessTokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      mcpClientId: true,
      user: { select: { id: true, deactivatedAt: true, oidcSub: true, lastKnownClaims: true } },
    },
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  if (session.user.deactivatedAt !== null) return null;

  return {
    id: session.id,
    expiresAt: session.expiresAt,
    mcpClientId: session.mcpClientId,
    userId: session.user.id,
    oidcSub: session.user.oidcSub ?? null,
    lastKnownClaims: session.user.lastKnownClaims as Record<string, unknown> | null,
  };
}

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
  userOidcSub: string | null;
  userClaims: Record<string, unknown>;
}

async function resolveSession(req: Request, res: Response) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required" });
    return null;
  }

  const session = await lookupOAuthSession(authHeader.slice(7));
  if (!session) {
    res.status(401).json({ error: "invalid_token" });
    return null;
  }

  return session;
}

export async function requireBearerAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const session = await resolveSession(req, res);
  if (!session) return;

  (req as AuthenticatedRequest).userId = session.userId;
  (req as AuthenticatedRequest).sessionId = session.id;
  (req as AuthenticatedRequest).userOidcSub = session.oidcSub;
  (req as AuthenticatedRequest).userClaims = session.lastKnownClaims ?? {};
  next();
}

