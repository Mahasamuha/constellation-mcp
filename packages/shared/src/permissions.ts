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
  return knownAccess(resolveAccess(blob, subject));
}

/** Any access value other than the three known levels is "none", so a typo never grants. */
function knownAccess(access: string): string {
  return Object.hasOwn(ACCESS_RANK, access) ? access : "none";
}

function resolveAccess(blob: PermissionBlob, subject: PermissionSubject): string {
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

/** Most groups accepted from one token, and the longest name. */
export const MAX_GROUPS = 256;
export const MAX_GROUP_LENGTH = 256;

/** A `groups` claim is present but unusable. Callers refuse the request. */
export class InvalidGroupsError extends Error {}

/**
 * Reads the `groups` claim from an access token's claims (or an envelope's `user_claims`).
 * An absent claim is no groups. A present one must be an array of at most MAX_GROUPS
 * non-empty strings of at most MAX_GROUP_LENGTH characters, or this throws
 * InvalidGroupsError: a group override can deny, so dropping or truncating entries could
 * silently widen access.
 */
export function groupsFromClaims(claims: Record<string, unknown>): string[] {
  if (!Object.hasOwn(claims, "groups") || claims["groups"] === undefined) return [];
  const raw = claims["groups"];
  if (!Array.isArray(raw)) throw new InvalidGroupsError("groups claim is not an array");
  if (raw.length > MAX_GROUPS) throw new InvalidGroupsError(`groups claim has more than ${MAX_GROUPS} entries`);
  for (const g of raw) {
    if (typeof g !== "string" || g.length === 0 || g.length > MAX_GROUP_LENGTH) {
      throw new InvalidGroupsError("groups claim has an entry that is not a non-empty string of at most 256 characters");
    }
  }
  return [...raw] as string[];
}
