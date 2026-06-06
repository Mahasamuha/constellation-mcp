# ADR 0004: OAuth 2.0 as the MCP Client Authentication Standard

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The broker needs to authenticate MCP clients (Claude, Cursor, GitHub Copilot) before
routing tool calls to agents. Options include API keys, shared secrets, OAuth, and
OIDC. The MCP specification defines an OAuth 2.0-based auth model; the broker must
decide how closely to follow it and which flows to support.

## Decision

The broker implements OAuth 2.0 per the MCP auth specification:

- **MCP clients** authenticate via the Authorization Code flow with mandatory PKCE
  (S256). PKCE is required; the broker rejects `/oauth/authorize` requests that omit
  `code_challenge`.
- **Dynamic Client Registration** (RFC 7591) is supported as the primary client
  onboarding path. Claude, Cursor, and GitHub Copilot all attempt DCR automatically
  on first connection; this eliminates per-client pre-registration for most cases.
- **Agent CLI and broker CLI** authenticate via the Device Code flow (RFC 8628).
  Scope determines which flow is served:
  - `agent:register` — creates an agent registration, returns an agent token
  - (formerly `broker:manage`, now removed — see ADR 0007)
- The broker acts as an OAuth 2.0 authorization server to MCP clients and as an
  OIDC client to an upstream identity provider (Google, Azure AD, Authentik, or any
  OIDC-compliant provider).
- The `/.well-known/oauth-authorization-server` discovery document is exposed so
  MCP clients can find the authorization endpoint automatically.

## Rationale

Following the MCP auth spec means compliant clients work without custom configuration.
Claude, Cursor, and Copilot all attempt DCR and the Authorization Code + PKCE flow
automatically when they discover the well-known endpoint — no manual OAuth setup
required for the common case.

PKCE is mandatory (not optional) because the MCP auth spec is based on OAuth 2.1,
which mandates it for all authorization code flows. All compliant MCP clients support it.

Delegating identity to an upstream OIDC provider avoids building user management
(password storage, MFA, account recovery) into the broker for the OIDC mode. Local
auth (`AUTH_MODE=local`) is supported for offline or simple deployments.

## Alternatives Considered

**API key per user:** simpler to implement but requires manual key distribution and
rotation. No standard discovery mechanism means MCP clients can't auto-configure.

**mTLS:** strong but requires certificate management on every client. Not supported
by any current MCP client.

## Consequences

- Tokens (agent and OAuth) are 32-byte cryptographically random values stored as
  SHA-256 hashes in Postgres. They are never logged in plaintext.
- Access tokens default to 24-hour lifetime; refresh tokens default to 30 days.
  Both are configurable via broker environment variables.
- Refresh tokens are rotated on use. If a refresh token expires, the client prompts
  re-authentication.
- Users are keyed on `(oidcSub, oidcIssuer)`. Switching OIDC providers will orphan
  existing user rows rather than merge them — documented in operator notes.
- OIDC scopes forwarded to the upstream provider are hardcoded to `openid email profile`.
  Group-based access control would require a code change to extend scope.
- Unactivated dynamic clients (registered but never completed an auth flow) are pruned
  on a TTL to bound DB growth. A hard cap is avoided because it becomes a DoS vector
  (attacker fills the cap, legitimate clients can't register).
