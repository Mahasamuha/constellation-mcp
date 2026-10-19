# ADR 0021: Client ID Metadata Documents; Relay Consent Interstitial in OIDC Mode

**Status:** Accepted
**Date:** 2026-10-19

## Context

The MCP authorization specification (2026-07-28) makes OAuth Client ID Metadata
Documents (CIMD, draft-ietf-oauth-client-id-metadata-document) the preferred client
registration mechanism and deprecates Dynamic Client Registration, which it keeps only
for backwards compatibility. With CIMD, a client's `client_id` is an HTTPS URL that
serves a JSON document describing the client. The authorization server fetches that
document instead of storing a registration.

Fetching client-supplied URLs exposes the relay to server-side request forgery (SSRF).
The MCP spec also requires the authorization server to "clearly display the redirect URI
hostname during authorization". In OIDC mode the relay redirected straight to the
upstream provider and rendered nothing about the MCP client, which already left DCR
clients short of that requirement.

## Decision

- **CIMD is supported alongside DCR.** Authorization server metadata advertises
  `client_id_metadata_document_supported: true`. A `client_id` beginning with
  `https://` is resolved as a metadata document URL. DCR client ids are cuids and never
  collide with that prefix.
- **Documents are cached in `oauth_clients`.** A resolved CIMD client is upserted as an
  `OauthClient` row whose `id` is the URL (`is_metadata_document = true`). This is
  required because `OauthSession` has a foreign key to `OauthClient`, and it also lets
  the cache survive restarts. The cache lifetime follows `Cache-Control: max-age`,
  clamped to between 5 minutes and 24 hours, with a 1-hour default. `no-store`,
  `no-cache` or `max-age=0` force a re-fetch on every authorization. Fetch failures and invalid
  documents are never cached, and a failed re-fetch aborts the authorization.
- **Fetches are SSRF-hardened.**
  - Addresses: IANA special-use IPv4 and IPv6 ranges are refused. The check runs in the
    socket's DNS lookup hook, so it validates the address actually connected to, and IP
    literals are checked separately.
  - Responses: redirects are never followed, the response must be a `200` with a JSON
    content type, and responses are capped at 5 KB and 5 seconds.
  - Implementation: built-in `node:https`, so there is no new dependency.
- **Validation is strict.**
  - The URL must be canonical, use `https`, and have a non-root path, with no userinfo,
    no fragment, and no dot segments.
  - The document's `client_id` must equal the URL, and `client_name` and
    `redirect_uris` are required. An omitted `grant_types` defaults to
    `authorization_code` and `refresh_token`, since the relay issues refresh tokens;
    DCR registrations get the same default.
  - Client secrets are forbidden in the document, and `token_endpoint_auth_method` must
    be `none` or absent.
  - Each redirect URI must pass the same `isAllowedRedirectUri` check as DCR, so
    `OAUTH_ALLOWED_REDIRECT_ORIGINS` applies to both. Disallowed URIs are dropped, and
    the document is rejected only if none remain.
- **OIDC mode gets a relay-rendered consent interstitial** for every authorization-code
  client, CIMD and DCR alike, shown before the upstream redirect.
  - The page shows the client name, whether its identity is verified (the document's
    host for CIMD, "not verified" for DCR), and the redirect hostname.
  - It warns when the redirect targets loopback.
  - Approve continues to the upstream provider. Deny redirects to the client with
    `error=access_denied`.
  - In local-auth mode, the login page shows the same disclosure in its banner.
- **CIMD clients that never complete an auth flow are pruned** on the
  `OAUTH_DYNAMIC_CLIENT_TTL_HOURS` TTL. The prune is keyed on `metadata_expires_at`
  rather than `created_at`: any authorization after expiry re-fetches and bumps that
  value, so a row cannot be pruned while a flow is in progress.

## Rationale

CIMD ties client identity to a domain the client controls. This makes the consent
display meaningful and needs no secret because documents are public.

CIMD is not a database-growth fix. Any unique `https` `client_id` with a valid document
creates an `oauth_clients` row at `/oauth/authorize`, before authentication, so it is a
growth vector comparable to `/oauth/register`. It is bounded the same way: the TTL prune
(`OAUTH_DYNAMIC_CLIENT_TTL_HOURS`, keyed on `metadata_expires_at`) and the default HTTP
rate-limit bucket on `/oauth/authorize`.

Keeping DCR avoids locking out clients that have not adopted CIMD yet.

A single interstitial for all clients closes the existing DCR display gap without a
separate code path. It costs one extra click per OIDC-mode authorization.

## Alternatives Considered

**Replace DCR with CIMD:** cleaner, but some MCP clients do not support CIMD yet.

**In-memory metadata cache:** simpler, but it would still need an `OauthClient` row for
the session foreign key, and it would lose the cache on restart.

**Use `fetch` with an SSRF library:** adds a dependency. The guard is small enough to
own, and connect-time lookup validation is simpler to get right with `node:https`.

**Interstitial for CIMD clients only:** smaller change, but leaves DCR clients without
the required redirect-host display.

## Consequences

- OIDC-mode users see a relay consent page before every sign-in redirect.
- A CIMD client whose redirect URIs are all outside `OAUTH_ALLOWED_REDIRECT_ORIGINS`
  (loopback aside) cannot authorize. Operators must allowlist the redirect origins of
  CIMD clients just as they do for DCR clients.
- Refresh does not re-validate a CIMD client's document. `handleRefreshTokenGrant` relies
  on the existing session and client row, deliberately. Taking a document down or
  changing it does not stop refresh; revoking a client's access requires revoking its
  sessions.
- The relay makes outbound HTTPS requests to client-chosen hosts. Deployments that need
  tighter control should also restrict egress at the network layer.
- Not supported:
  - `private_key_jwt` client authentication.
  - Domain-based trust policies for CIMD hosts.
  - The draft's loopback exception for development.
- RFC 9207 `iss` in authorization responses and RFC 8707 audience binding remain
  separate work.
