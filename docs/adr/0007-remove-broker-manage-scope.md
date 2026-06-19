# ADR 0007: Remove relay:manage Scope; Replace with Per-User RLS Filtering

**Status:** Accepted  
**Date:** 2026-06-06

## Context

All `/api/*` relay management endpoints were originally gated by a `relay:manage`
scope, obtained via `constellation relay login`. The intent was to separate management
API access from ordinary MCP client access.

## Decision

The `relay:manage` scope has been removed. The `requireRelayManage` middleware is
deleted. All `/api/*` endpoints are now gated by `requireBearerAuth` only, with
per-route authorization enforced by filtering results to the calling user's `userId`.

The static first-party CLI client was renamed from `"relay-manage"` to
`"constellation-cli"` for clarity.

## Rationale

The `relay:manage` scope was security theater. Every API query already filtered by
`userId`, so the scope provided no isolation beyond what the query layer enforced.
Any authenticated user could obtain a `relay:manage`-scoped token by running
`constellation relay login` — there was no additional approval step.

The real access control is row-level: an agent can only be revoked by its owning user,
a filter can only be deleted by the user who created it, and so on. This is enforced
at the query layer unconditionally. The scope check was an extra step that added
complexity without adding security.

Removing the scope simplifies the auth model: one token type for management, scoped to
the user by the query layer. Admin-only operations are handled separately by the role
and escalation model (see ADR 0008).

## Alternatives Considered

**Keeping relay:manage but making it meaningful:** require an explicit admin approval
step to grant the scope, so it's not freely obtainable. Rejected because the underlying
issue is that API endpoints already filter by userId — adding a scope gate on top
adds a layer that doesn't change what data is accessible.

**Per-endpoint scopes:** fine-grained scopes per management operation. Rejected as
over-engineered for a personal tool where the user is always acting on their own data.

## Consequences

- `requireRelayManage` is removed from `packages/relay/src/middleware.ts`.
- `apiRouter.use(requireRelayManage)` is replaced with `apiRouter.use(requireBearerAuth)`.
- The `relay:manage` grant type strip from the dynamic client registration handler
  is removed.
- Existing `relay-session.yaml` files with `relay:manage`-scoped tokens continue
  to work until expiry (the token is still a valid OAuth session). Re-login issues
  a standard session token.
- Admin-gated operations (user management, hub registration) use the separate
  `requireAdmin` middleware that checks `adminUntil` on the session row (ADR 0008).
