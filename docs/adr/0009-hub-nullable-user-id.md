# ADR 0009: Hub Uses Nullable userId on ExecutorToken (Service-Level Token)

**Status:** Accepted  
**Date:** 2026-06-06

> **Update (2026-06-13):** `AgentToken`/`AgentTokenType` were renamed to
> `ExecutorToken`/`ExecutorTokenType`, and the `PERSONAL`/`SHARED` values to
> `NODE`/`HUB`, as part of the broker→relay/agent→node/shared-agent→hub
> vocabulary rename. This ADR has been updated to use the current names.

## Context

The personal node model ties each `ExecutorToken` to a specific `userId`. The relay
connection for a personal node is implicitly scoped to that user — all RPCs dispatched
on the connection operate on that user's labels. A hub serves multiple users from a
single connection, so a user-bound token does not fit.

## Decision

`userId` on `ExecutorToken` is made nullable. A `tokenType` discriminator is added:
`enum ExecutorTokenType { NODE, HUB }`. A `HUB` token has `null` userId.

Per-request user identity for hub connections comes exclusively from
`user_oidc_sub` forwarded in the RPC envelope — not from the connection's token.

Unique constraint changes on the `Executor` model:
- Personal nodes: `@@unique([userId, host])` (partial, where `user_id IS NOT NULL`)
- Hubs: `@@unique([executorTokenId, host])` — the token scopes the `Executor` row since
  `userId` is null (Postgres `NULL != NULL` would not enforce uniqueness otherwise)

## Rationale

The existing token model assumed one node = one user. The hub deployment breaks this
assumption: a hub on a NAS or dev server serves requests for multiple users from a
single relay connection. The relay must know which user's identity to resolve for each
RPC, which comes from the OAuth session of the MCP client — not from the agent
connection itself.

Making `userId` nullable with an explicit `tokenType` discriminator is clearer than
inferring token type from null checks alone. It also documents intent: a `HUB` token
is not a personal token with a missing user — it is a structurally different thing.

The `@@unique` constraint change is required because Postgres treats `NULL != NULL`,
so a partial unique constraint on `(userId, host)` cannot enforce uniqueness for
hubs where `userId` is always null.

## Alternatives Considered

**Separate `HubToken` table:** cleaner schema separation but requires JOIN
logic and a second token validation path. For a discriminated union of two cases,
a single table with a type field is simpler.

**Service user account:** create a relay user account for each hub installation
and use a personal token bound to that account. Rejected because it pollutes the
user table with synthetic service accounts and requires ongoing management.

## Consequences

- `HUB` tokens are created via `constellation hub register` (device code flow
  with `agent:register:shared` scope, admin approval required — see ADR 0008) or
  the break-glass path `constellation relay token create --shared`.
- `HUB` tokens have no user identity. If a `HUB` token connection receives an
  RPC without `user_oidc_sub` in the envelope, it is rejected — no fallback.
- The relay's connection map must accommodate both personal and shared connections.
  Personal connections are keyed by `executorId`; hub connections are keyed by
  machine ID (stable across token rotations and process restarts).
- Existing personal node behavior is unchanged. `NODE` tokens retain a non-null
  `userId` and behave exactly as before.
- `HubPathLabel` is a separate table (see ADR 0011) for syncing hub label
  registries to the relay for optimistic discovery.
