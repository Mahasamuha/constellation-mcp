import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

/** Lifetime of a pending authorization flow cookie, and of the auth code it ends in. */
export const FLOW_COOKIE_TTL_MS = 10 * 60 * 1000;

/**
 * authz_pending / login_pending are SameSite=Strict: they are only needed by same-origin
 * form POSTs from pages the relay itself rendered. oidc_pending is Lax because the
 * upstream IdP redirects the browser back to /oauth/callback as a cross-site top-level
 * GET, which a Strict cookie would not accompany.
 */
export type FlowCookieKind = "authz_pending" | "login_pending" | "oidc_pending";

const SAME_SITE = { authz_pending: "strict", login_pending: "strict", oidc_pending: "lax" } as const;

/** Sets a signed flow-state cookie under a fresh pending id and returns that id. */
export function setFlowCookie(res: Response, kind: FlowCookieKind, value: object): string {
  const pendingId = randomBytes(16).toString("hex");
  res.cookie(`${kind}_${pendingId}`, JSON.stringify(value), {
    httpOnly: true,
    secure: config.secureCookies,
    maxAge: FLOW_COOKIE_TTL_MS,
    sameSite: SAME_SITE[kind],
    signed: true,
  });
  return pendingId;
}

/** Reads and parses a flow cookie without consuming it. Missing, unparseable, or wrongly-shaped
 * values all yield undefined, so callers never operate on attacker-shaped or absent state. */
export function readFlowCookie<T>(
  req: Request,
  kind: FlowCookieKind,
  pendingId: string,
  isShape: (v: unknown) => v is T,
): T | undefined {
  const raw = (req.signedCookies as Record<string, unknown>)[`${kind}_${pendingId}`];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isShape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearFlowCookie(res: Response, kind: FlowCookieKind, pendingId: string): void {
  res.clearCookie(`${kind}_${pendingId}`);
}

/** Reads a flow cookie and clears it (single use). The cookie is cleared even when it is
 * malformed, so a bad one doesn't linger until it expires. */
export function takeFlowCookie<T>(
  req: Request,
  res: Response,
  kind: FlowCookieKind,
  pendingId: string,
  isShape: (v: unknown) => v is T,
): T | undefined {
  const value = readFlowCookie(req, kind, pendingId, isShape);
  clearFlowCookie(res, kind, pendingId);
  return value;
}
