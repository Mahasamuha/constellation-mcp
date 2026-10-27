/**
 * One per-user rule in a share's permission blob. Exactly one of `sub` or `group` is set:
 * `sub` is the user's asterism subject (the `sub` of the access token), `group` is a name
 * from the token's `groups` claim.
 */
export type PermissionOverride =
  | { sub: string; group?: never; access: string }
  | { group: string; sub?: never; access: string };

export interface PermissionBlob {
  default: string;
  overrides?: PermissionOverride[];
}

/** Who is asking, as far as share permissions are concerned. */
export interface PermissionSubject {
  sub: string | null;
  groups: readonly string[];
}

const ACCESS_RANK: Record<string, number> = { none: 0, "read-only": 1, "read-write": 2 };

/** Ranks an access level; anything unrecognised ranks as "none". */
function rank(access: string): number {
  return ACCESS_RANK[access] ?? 0;
}

/**
 * Resolves a user's access to a share. A `sub` override wins outright, since it names the
 * user. Otherwise the most permissive matching `group` override applies. Otherwise the
 * default does.
 */
export function evaluatePermissionBlob(blob: PermissionBlob, subject: PermissionSubject): string {
  const overrides = blob.overrides ?? [];
  if (subject.sub) {
    const bySub = overrides.find((o) => o.sub !== undefined && o.sub === subject.sub);
    if (bySub) return bySub.access;
  }
  let best: string | null = null;
  for (const o of overrides) {
    if (o.group === undefined || !subject.groups.includes(o.group)) continue;
    if (best === null || rank(o.access) > rank(best)) best = o.access;
  }
  return best ?? (blob.default || "none");
}

/** Most groups read from one token. Asterism releases them as-is, so cap what we trust. */
export const MAX_GROUPS = 256;
const MAX_GROUP_LENGTH = 256;

/**
 * Reads the `groups` claim from an access token's claims (or an envelope's `user_claims`).
 * Returns only non-empty strings, at most MAX_GROUPS of them; any other shape yields [].
 */
export function groupsFromClaims(claims: Record<string, unknown>): string[] {
  const raw = claims["groups"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= MAX_GROUP_LENGTH)
    .slice(0, MAX_GROUPS);
}
