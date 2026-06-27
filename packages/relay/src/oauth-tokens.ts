import { Response } from "express";
import { prisma } from "./db.js";
import { generateToken, hashToken } from "@constellation/shared";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Shared OAuth access/refresh token-pair issuance — used by both the
// authorization_code and device_code grant handlers (oauth.ts and device.ts).
// ---------------------------------------------------------------------------

export interface TokenPair {
  accessToken: string;
  accessTokenHash: string;
  refreshToken: string;
  refreshTokenHash: string;
  expiresAt: Date;
  refreshExpiresAt: Date;
  expiresInSec: number;
}

export function makeTokenPair(): TokenPair {
  const accessToken = generateToken();
  const refreshToken = generateToken();
  const accessTtlHours = config.oauthAccessTokenTtlHours;
  const refreshTtlDays = config.oauthRefreshTokenTtlDays;
  const now = new Date();
  return {
    accessToken,
    accessTokenHash: hashToken(accessToken),
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: new Date(now.getTime() + accessTtlHours * 3600 * 1000),
    refreshExpiresAt: new Date(now.getTime() + refreshTtlDays * 86400 * 1000),
    expiresInSec: accessTtlHours * 3600,
  };
}

export function sendTokenResponse(res: Response, tokens: TokenPair): void {
  res.set("Cache-Control", "no-store");
  res.json({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresInSec,
    refresh_token: tokens.refreshToken,
  });
}

/** Creates a new OAuth session row with a fresh token pair and returns the tokens. */
export async function issueOAuthSession(userId: string, mcpClientId: string): Promise<TokenPair> {
  const tokens = makeTokenPair();
  await prisma.oauthSession.create({
    data: {
      userId,
      mcpClientId,
      accessTokenHash: tokens.accessTokenHash,
      expiresAt: tokens.expiresAt,
      refreshTokenHash: tokens.refreshTokenHash,
      refreshTokenExpiresAt: tokens.refreshExpiresAt,
    },
  });
  return tokens;
}
