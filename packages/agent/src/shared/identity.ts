import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IdentityConfig } from "./config.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  username: string;
  uid: number;
  gid: number;
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
 * Resolves a username to uid/gid via getent passwd (NSS-aware; works with LDAP/SSSD).
 * Returns null if the user does not exist on this system.
 */
export async function getpwnam(username: string): Promise<{ uid: number; gid: number } | null> {
  if (!username) return null;
  try {
    const { stdout } = await execFileAsync("getent", ["passwd", username]);
    const out = stdout.trim();
    if (!out) return null;
    const parts = out.split(":");
    if (parts.length < 4) return null;
    const uid = parseInt(parts[2]!, 10);
    const gid = parseInt(parts[3]!, 10);
    if (isNaN(uid) || isNaN(gid)) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Three-tier resolution chain
// ---------------------------------------------------------------------------

/**
 * Resolves OS identity for an incoming RPC using a three-tier chain:
 *   Tier 1 — custom OIDC claims (config.claims list)
 *   Tier 2 — explicit oidc_sub → local username map (config.user_map)
 *   Tier 3 — preferred_username claim (opt-in, disabled by default)
 *
 * Returns a typed error if no tier resolves. Never falls through to the
 * agent's own identity.
 */
export async function resolveIdentity(
  userClaims: Record<string, unknown>,
  userOidcSub: string | null,
  config: IdentityConfig
): Promise<ResolvedIdentity | IdentityResolutionError> {
  // Tier 1: custom OIDC claims in config order
  for (const claimName of config.claims) {
    const claimValue = userClaims[claimName];
    if (typeof claimValue === "string" && claimValue) {
      const pw = await getpwnam(claimValue);
      if (pw) {
        return { username: claimValue, uid: pw.uid, gid: pw.gid };
      }
    }
  }

  // Tier 2: explicit oidc_sub → local username map
  if (userOidcSub) {
    const entry = config.user_map.find((e) => e.oidc_sub === userOidcSub);
    if (entry) {
      const pw = await getpwnam(entry.local_username);
      if (pw) {
        return { username: entry.local_username, uid: pw.uid, gid: pw.gid };
      }
      // user_map entry found but the mapped username doesn't exist on this OS — hard rejection,
      // no fallthrough to Tier 3. The admin explicitly mapped this sub; ambiguity is worse than failure.
      return {
        kind: "identity_error",
        message: `user_map entry for oidc_sub '${userOidcSub}' maps to '${entry.local_username}' which does not exist on this system`,
      };
    }
  }

  // Tier 3: preferred_username (opt-in; disabled by default)
  if (config.allow_preferred_username) {
    const preferred = userClaims["preferred_username"];
    if (typeof preferred === "string" && preferred) {
      const pw = await getpwnam(preferred);
      if (pw) {
        return { username: preferred, uid: pw.uid, gid: pw.gid };
      }
    }
  }

  return {
    kind: "identity_error",
    message: "Could not resolve an OS identity for this user. Contact the shared agent administrator.",
  };
}
