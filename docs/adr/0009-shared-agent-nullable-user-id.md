# ADR 0009: Shared Agent Uses Nullable userId on AgentToken (Service-Level Token)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The personal agent model ties each `AgentToken` to a specific `userId`. The broker
connection for a personal agent is implicitly scoped to that user — all RPCs dispatched
on the connection operate on that user's labels. The shared modality requires an agent
that serves multiple users from a single connection, so a user-bound token does not fit.

## Decision

`userId` on `AgentToken` is made nullable. A `tokenType` discriminator is added:
`enum AgentTokenType { PERSONAL, SHARED }`. A `SHARED` token has `null` userId.

Per-request user identity for shared agent connections comes exclusively from
`user_oidc_sub` forwarded in the RPC envelope — not from the connection's token.

Unique constraint changes on the `Agent` model:
- Personal agents: `@@unique([userId, host])` (partial, where `user_id IS NOT NULL`)
- Shared agents: `@@unique([agentTokenId, host])` — token scopes the agent installation
  since `userId` is null (Postgres `NULL != NULL` would not enforce uniqueness otherwise)

## Rationale

The existing token model assumed one agent = one user. The shared modality breaks this
assumption: a shared agent on a NAS or dev server serves requests for multiple users
from a single broker connection. The broker must know which user's identity to resolve
for each RPC, which comes from the OAuth session of the MCP client — not from the
agent connection itself.

Making `userId` nullable with an explicit `tokenType` discriminator is clearer than
inferring token type from null checks alone. It also documents intent: a `SHARED` token
is not a personal token with a missing user — it is a structurally different thing.

The `@@unique` constraint change is required because Postgres treats `NULL != NULL`,
so a partial unique constraint on `(userId, host)` cannot enforce uniqueness for
shared agents where `userId` is always null.

## Alternatives Considered

**Separate `SharedAgentToken` table:** cleaner schema separation but requires JOIN
logic and a second token validation path. For a discriminated union of two cases,
a single table with a type field is simpler.

**Service user account:** create a broker user account for each shared agent
installation and use a personal token bound to that account. Rejected because it
pollutes the user table with synthetic service accounts and requires ongoing management.

## Consequences

- `SHARED` tokens are created via `constellation shared-agent register` (device code
  flow with `agent:register:shared` scope, admin approval required — see ADR 0008)
  or the break-glass path `constellation broker token create --shared`.
- `SHARED` tokens have no user identity. If a `SHARED` token connection receives an
  RPC without `user_oidc_sub` in the envelope, it is rejected — no fallback.
- The broker's connection map must accommodate both personal and shared connections.
  Personal connections are keyed by `agent_id`; shared connections are keyed by
  machine ID (stable across token rotations and process restarts).
- Existing personal agent behavior is unchanged. `PERSONAL` tokens retain a non-null
  `userId` and behave exactly as before.
- `SharedPathLabel` is a separate table (see schema in `shared-modality.md §2.3.1`)
  for syncing shared agent label registries to the broker for optimistic discovery.
