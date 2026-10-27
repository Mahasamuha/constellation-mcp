/**
 * The caller of an MCP tool or /api route, taken from a verified asterism access token.
 * `id` is the token's `sub`, which is also the `users.id` primary key (M2 kept ids).
 * `claims` are the token's non-registered claims as released by asterism (for example
 * `email`, `groups`, `constellation_username`); `groups` is `groupsFromClaims(claims)`.
 */
export interface RequestUser {
  id: string;
  clientId: string;
  scopes: readonly string[];
  groups: readonly string[];
  claims: Record<string, unknown>;
}

/** The base scope every MCP and /api call needs. Declared in our RFC 9728 metadata. */
export const BASE_SCOPE = "relay";
/** Step-up only: never in scopes_supported, obtained through a 403 insufficient_scope. */
export const ADMIN_SCOPE = "admin";
