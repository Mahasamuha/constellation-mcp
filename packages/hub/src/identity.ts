import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IdentityConfig } from "./config.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("identity");

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  username: string;
  uid: number;
  gid: number;
  /** Home directory from the passwd entry — used to build a clean env for the subnode worker. */
  home: string;
}

export interface IdentityResolutionError {
  kind: "identity_error";
  message: string;
}

export function isIdentityError(v: ResolvedIdentity | IdentityResolutionError): v is IdentityResolutionError {
  return "kind" in v;
}

// ---------------------------------------------------------------------------
// OS lookup via getent (NSS-aware; works with LDAP/SSSD)
// ---------------------------------------------------------------------------

/**
 * Resolves a username to name/uid/gid/home via getent passwd (NSS-aware; works with LDAP/SSSD).
 * Returns null if the user does not exist on this system. `name` is the passwd entry's own
 * name field: getent also resolves a numeric argument as a UID, so callers that took the
 * username from untrusted input must compare `name` to what they asked for (see
 * resolveOsUser).
 */
export async function getpwnam(username: string): Promise<{ name: string; uid: number; gid: number; home: string } | null> {
  if (!username) return null;
  try {
    const { stdout } = await execFileAsync("getent", ["passwd", "--", username]);
    const out = stdout.trim();
    if (!out) return null;
    // passwd format: name:passwd:uid:gid:gecos:home:shell
    const parts = out.split(":");
    if (parts.length < 4) return null;
    const uid = parseInt(parts[2]!, 10);
    const gid = parseInt(parts[3]!, 10);
    if (isNaN(uid) || isNaN(gid)) return null;
    // Some accounts (service users, minimal NSS setups) have an empty homedir
    // field. Don't fail resolution over it — fall back to "/" the way most
    // tools do when HOME is unset, rather than rejecting an otherwise-valid user.
    const home = parts[5] || "/";
    return { name: parts[0]!, uid, gid, home };
  } catch {
    return null;
  }
}

/**
 * Resolves the full set of group IDs (primary + supplementary) for a username
 * via `id -G` (NSS-aware; resolves the same membership that initgroups() will
 * apply to the subnode worker at privilege-drop time). Returns null if the
 * lookup fails — callers should treat that as "cannot verify, do not proceed"
 * rather than "user has no groups".
 */
export async function getGroupIds(username: string): Promise<number[] | null> {
  if (!username) return null;
  try {
    const { stdout } = await execFileAsync("id", ["-G", "--", username]);
    const ids = stdout
      .trim()
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Username validation
// ---------------------------------------------------------------------------

/**
 * Cheap pre-filter for a username that came from a token claim or the config. The first
 * character must be a letter or underscore, so a value is never numeric (getent resolves
 * "1000" as a UID) and never starts with "-". Allows mixed case, ".", and SSSD names like
 * "user@domain.example". This is only a pre-filter; the exact-name check in resolveOsUser
 * is the real guard.
 */
export const USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._@-]{0,255}$/;

/**
 * Looks up `candidate` and returns the account only if it is exactly the passwd entry
 * named `candidate` (case-sensitive). Returns null on an invalid pattern, no such user,
 * or a passwd name that differs from the candidate (for example a UID or alias match).
 * Callers must use the returned `username` (the passwd name) from then on.
 */
async function resolveOsUser(candidate: unknown): Promise<ResolvedIdentity | null> {
  if (typeof candidate !== "string" || !USERNAME_PATTERN.test(candidate)) return null;
  const pw = await getpwnam(candidate);
  if (!pw || pw.name !== candidate) return null;
  return { username: pw.name, uid: pw.uid, gid: pw.gid, home: pw.home };
}

// ---------------------------------------------------------------------------
// Two-tier resolution chain
// ---------------------------------------------------------------------------

const REFUSED: IdentityResolutionError = {
  kind: "identity_error",
  message: "Could not resolve an OS identity for this user. Contact the hub administrator.",
};

/**
 * Resolves OS identity for an incoming RPC using a two-tier chain:
 *   Tier 1 — custom claims (config.claims list; asterism releases constellation_username)
 *   Tier 2 — explicit sub -> local username map (config.user_map)
 *
 * Claim values are untrusted input and must match the pre-filter pattern and be the exact
 * passwd name of an existing account. A claim that is present but not a valid, resolvable
 * username is a hard refusal: only an absent claim moves on to the next tier. Returns a
 * typed error if no tier resolves. Never falls through to the hub's own identity.
 */
export async function resolveIdentity(
  userClaims: Record<string, unknown>,
  userSub: string,
  config: IdentityConfig
): Promise<ResolvedIdentity | IdentityResolutionError> {
  // Tier 1: custom claims in config order
  for (const claimName of config.claims) {
    if (!Object.hasOwn(userClaims, claimName)) continue;
    const claimValue = userClaims[claimName];
    if (claimValue === undefined) continue;
    const resolved = await resolveOsUser(claimValue);
    if (resolved) return resolved;
    // Log the detail operator-side only; the value is attacker-influenced, so bound it.
    log.warn(
      { sub: userSub, claim: claimName, value: typeof claimValue === "string" ? claimValue.slice(0, 64) : typeof claimValue },
      "identity claim is present but invalid, unresolved or not the exact account name — refusing"
    );
    return REFUSED;
  }

  // Tier 2: explicit sub -> local username map
  if (userSub) {
    const entry = config.user_map.find((e) => e.sub === userSub);
    if (entry) {
      const resolved = await resolveOsUser(entry.local_username);
      if (resolved) return resolved;
      // user_map entry found but the mapped username doesn't resolve — hard refusal. The admin
      // explicitly mapped this sub; ambiguity is worse than failure.
      // Log the detail operator-side; return a generic message so local_username is not disclosed.
      log.warn({ sub: userSub, local_username: entry.local_username }, "user_map entry maps to a non-existent or non-exact local user");
      return REFUSED;
    }
  }

  return REFUSED;
}
