import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generates a cryptographically random 32-byte token as a 64-char hex string. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** The shape of every executor token generateToken mints: 64 lowercase hex characters. A token
 * received from the relay that doesn't match is refused before it is stored or sent anywhere. */
export const EXECUTOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Returns the SHA-256 hash of a token for storage. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string equality — use for any security-sensitive comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
