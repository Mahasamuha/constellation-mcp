# ADR 0022: asterism Is the Authorization Server; Constellation Is a Resource Server

**Status:** Accepted — supersedes [ADR 0004](0004-oauth-mcp-auth.md), [ADR 0008](0008-admin-elevation-admin-until.md), [ADR 0020](0020-rfc9728-discovery-public-only-dcr.md) and [ADR 0021](0021-client-id-metadata-documents.md)
**Date:** 2026-10-27

## Context

The relay was both a resource server and a full OAuth authorization server: authorization
code with PKCE, device authorization, dynamic client registration, Client ID Metadata
Document fetching with SSRF hardening, a consent interstitial, refresh tokens, an OIDC
client (`openid-client`) for upstream sign-in, a local username/password mode with a
setup page, and an `adminUntil` elevation window on `OauthSession`. That is a large,
security-sensitive surface to maintain beside the product, and each of its pieces
(sessions, accounts, revocation, consent) is exactly what a dedicated authorization
server already does.

asterism is an external OAuth 2.1 authorization server built for this role. It owns
sign-in, local accounts, groups, consent, grants and revocation, and it issues JWT access
tokens that a resource server verifies with `@mahasamuha/asterism-verify`.

## Decision

- **The relay is only a resource server.** It verifies asterism-issued JWT access tokens
  (issuer `ASTERISM_ISSUER`, audience `${RELAY_URL}/mcp`) on `/mcp` and `/api`. Tokens are
  verified from asterism's published keys; the relay holds no sessions and stores no
  tokens.
- **Discovery is RFC 9728 only.** The relay serves protected resource metadata at
  `/.well-known/oauth-protected-resource/mcp`, pointing clients at asterism. It no
  longer serves authorization server metadata, `/oauth/*` or `/activate*`.
- **The relay is registered in asterism as a resource server.** asterism fetches the
  relay's metadata, which declares the `relay` scope and the fresh-sign-in-only `admin` and `register` scopes.
- **Admin is a scope plus a group.** `requireAdmin` requires the `admin` scope and
  membership of `ADMIN_GROUP` (default `constellation-admins`) in the token's `groups`.
  asterism issues the scope only after a fresh sign-in (a `403 insufficient_scope`, 5 minutes), and
  the group check means admin does not depend on asterism's `requireGroups` policy having
  been set. Stale groups can only deny, never grant, because the scope is required too. This replaces `User.role`, `ADMIN_GROUPS`,
  `RELAY_ADMIN_TOKEN` and the `adminUntil` window.
- **Client registration is CIMD.** The CLI, node and hub identify themselves with Client
  ID Metadata Documents served by the relay at `/clients/cli.json`, `/clients/node.json`
  and `/clients/hub.json`. The relay no longer fetches client documents, so the SSRF
  guard and `safe-fetch.ts` are gone.
- **Executors register with an access token.** `POST /api/executors/register` replaces
  the device-code flow. It takes a bearer token and keeps the registration rules (HUB
  revoke-and-replace, `host_name` validation).
- **`users` shrinks to `id` and `created_at`.** A row is created the first time a token
  `sub` is seen, and existing `users.id` values were kept because other tables reference
  them. Email, role, OIDC identity, claims and the deactivation flag are no longer
  stored. Identity attributes come from the token on each request.
- **The RPC envelope identifies users by asterism subject.** `user_oidc_sub` becomes
  `user_sub`, `user_groups` is added, and `user_claims` stays. Share permission overrides
  match on `{sub, access}` or `{group, access}`.
- **Account and session management move to asterism.** Sign-in, local accounts, user
  management, password resets and session revocation (`/grants`) are asterism features.
  The relay's `/api/sessions*`, `/api/users*`, promote/demote and `/api/account/deactivate`
  routes are removed.
- **Startup requires configuration.** `ASTERISM_ISSUER` must be an `https:` URL (`http:`
  on loopback for development) and `RELAY_URL` must be set.

## Rationale

One component owning authentication means one place to fix, audit and revoke. The relay
keeps only verification, which is stateless and small. Revocation, group membership and
step-up policy now take effect without relay code. Admin as a scope gated on a group
removes the separate bootstrap secret and the in-database role that could drift from the
identity provider.

## Alternatives Considered

**Keep the built-in server and add asterism as an upstream OIDC provider:** keeps the
largest maintenance surface and the duplicated session and consent logic.

**Opaque tokens with introspection:** adds a network call per request. JWT verification
against published keys needs none.

**Keep `User.role` and sync it from groups:** reintroduces drift between the stored role
and the identity provider.

## Consequences

- Only the node client may register a node and only the hub client a hub
  (`POST /api/executors/register` checks the token's `client_id`), so a token issued to a
  third-party MCP client cannot mint an executor token. Registration also needs the
  `register` scope, which asterism grants only after a fresh sign-in and a consent screen
  (a hub also needs `admin`).
- Every other `/api` route accepts only the CLI client's token, so MCP clients such as
  Claude.ai are limited to `/mcp`: they cannot change filters, revoke tokens or touch `/api`.
- Access tokens are short-lived and not individually revocable at the relay. Revoking a
  grant in asterism takes effect when the current token expires.
- The relay depends on asterism being reachable to fetch signing keys (cached). A
  deployment cannot run without asterism, and there is no standalone local-account mode.
- Deleting a user in asterism does not delete the relay's `users` row or its data.
- This is a breaking change for operators and clients:
  - Set `ASTERISM_ISSUER`; remove `AUTH_MODE`, `OIDC_*`, `COOKIE_SECRET`, `ADMIN_GROUPS`,
    `ADMIN_SESSION_DURATION`, `RELAY_ADMIN_TOKEN`, `OAUTH_*` and the
    `RATE_LIMIT_OAUTH_PER_15MIN`, `RATE_LIMIT_DEVICE_POLL_PER_15MIN` and
    `RATE_LIMIT_DEVICE_AUTH_PER_15MIN` settings.
  - Register the relay in asterism as a resource server, release the `groups`, `email` and
    `constellation_username` claims, and set the `admin` scope policy
    `--require-groups constellation-admins`, all before users connect (grants made earlier
    carry no such claims until the user re-consents). `groups` and
    `constellation_username` are only as trustworthy as their upstream source: never map
    them onto a user-editable claim in `OIDC_CLAIM_MAP`. See
    [Configuration](../configuration.md#operator-runbook-configure-asterism-before-users-connect).
  - Existing clients and executors must sign in again.
- Migration `0006_asterism_resource_server` drops the `auth_codes`, `device_codes`,
  `oauth_clients`, `oauth_sessions`, `local_users` and `login_failures` tables, the
  `RelayRole` type and the identity columns of `users`. It is not reversible without a
  backup.
