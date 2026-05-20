import { Request, Response, NextFunction } from "express";
import { prisma } from "./db.js";
import { hashToken } from "@constellation/shared";

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
