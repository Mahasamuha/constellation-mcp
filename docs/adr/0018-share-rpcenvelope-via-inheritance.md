# ADR 0018: Share RpcEnvelope via Inheritance; Nest Tool Params

**Status:** Accepted — supersedes [ADR 0001](0001-rpc-envelope-not-shared.md)
**Date:** 2026-06-21

## Context

A production-readiness audit flagged that `RpcEnvelope` was defined independently in
`packages/shared/src/rpc.ts` and `packages/relay/src/hub.ts`, and the two definitions
had drifted: the relay's copy added `user_oidc_sub`/`user_claims` but otherwise
duplicated the base fields by hand instead of extending it. Both definitions carried
an open `[key: string]: unknown` index signature, because the MCP tool call's own
arguments were spread flat into the same object as the envelope's routing metadata —
`{ request_id, tool, absolute_root, ...effectiveParams }` in
`packages/relay/src/router.ts`. Nothing stopped a tool argument from colliding with,
and — since the spread came last in the object literal — silently overwriting, a
routing field like `absolute_root` or `share`.

ADR 0001 considered and rejected sharing `RpcEnvelope`, including the exact "subtype"
pattern this ADR adopts (`NodeRpcEnvelope extends RpcEnvelope`), on the grounds that
"the indirection buys little" given how small and stable the two types were. That
analysis didn't have the index-signature drift in view — it was about whether
`user_oidc_sub`/`user_claims` should be optional on a single merged type (rejected,
correctly: that would weaken both contracts) — not about the actual duplication
risk that materialized.

A second thing ADR 0001 didn't anticipate: `packages/hub` (the separate hub package
that runs alongside an admin-defined share, distinct from the relay) also needs typed
access to `user_oidc_sub`/`user_claims` for OS-identity resolution
(`packages/hub/src/index.ts`'s `handleRpc`). It can't depend on `@constellation/relay`
for that type — wrong dependency direction, and a heavy package (Express, Prisma) for
hub to pull in for one interface.

## Decision

`RpcEnvelope`'s core fields now live in `@constellation/shared`
(`packages/shared/src/rpc.ts:22`):

```ts
export interface RpcEnvelope {
  request_id: string;
  tool: string;
  share: string;
  absolute_root: string;
  params: Record<string, unknown>;
}
```

Tool call arguments are nested under `params` instead of spread flat — router.ts now
builds `{ ..., params: effectiveParams }`, not `{ ..., ...effectiveParams }`. A tool
argument can no longer collide with a routing field; both index signatures are gone.

Relay's `RpcEnvelope` (`packages/relay/src/hub.ts:27`) now `extends` the shared base —
the exact subtype pattern ADR 0001 rejected — adding only the two fields it forwards
that node ignores and hub consumes:

```ts
export interface RpcEnvelope extends BaseRpcEnvelope {
  user_oidc_sub: string | null;
  user_claims: Record<string, unknown>;
}
```

Since hub-package can't import that type from `@constellation/relay`, it declares its
own equivalent local extension (`packages/hub/src/index.ts:16`,
`IncomingRpcEnvelope extends RpcEnvelope`) — same two fields, defined independently.
This is accepted duplication, unlike the duplication ADR 0001 was working around: it's
a stable two-line extension of a now-fully-typed base, not a full redefinition that can
silently diverge in shape.

## Rationale

ADR 0001's "indirection buys little" judgment was a fair read of the tradeoff *as it
stood* — two small, stable, independently-evolving types. What changed is that the
duplication wasn't actually independent: both copies needed the same open index
signature for the same reason (absorbing tool params), and that's exactly the kind of
shared concern that drifts unnoticed and was the production-readiness audit's actual
finding. Once tool params are nested — which ADR 0001 never considered, since it's
orthogonal to the sharing question — the envelope's own fields are few, named, and
unlikely to change independently per consumer. The cost side of "the indirection buys
little" is now close to zero (a two-field extension), while the benefit (one
authoritative definition of the fields every consumer agrees on) is concretely realized
by deleting `packages/hub/src/index.ts`'s `ROUTING_FIELDS` exclusion-filter, which
manually reconstructed "real" tool params by subtracting known envelope keys from the
flat object — a second place that would have silently broken if a routing field were
ever added without updating it.

## Alternatives Considered

**Leave ADR 0001's decision in place; just add a unit test asserting the two
definitions stay in sync.** Doesn't fix the actual collision risk (params still
spread flat), and a test asserting two independent definitions match is itself a third
thing to keep in sync — it would have caught drift after the fact, not prevented the
underlying design from having a collision path at all.

**Merge `user_oidc_sub`/`user_claims` into the shared base type as required fields**
(rather than as relay's extension), since in practice every envelope the relay builds
already includes them regardless of destination. Rejected: node's `handleRpc` never
reads them, and ADR 0001's original objection — that this conflates "what the relay
guarantees it sends" with "what every consumer needs" — still holds for that part of
the original reasoning. Keeping them as an extension preserves the distinction; only
the *sharing mechanism* (duplication vs. inheritance) was the part worth revisiting.

## Consequences

- `RpcEnvelope`'s shape is defined once, in `@constellation/shared`. Relay and the hub
  package each extend it locally with the two identity fields they need; node uses the
  base type unmodified.
- If a new envelope-wide field is ever needed, it's added once, in the shared base —
  not synchronized by hand across two (or three) definitions.
- `packages/hub/src/index.ts`'s `handleRpc` no longer reconstructs `params` by
  filtering the envelope; `envelope.params` already is that.
- `resolveDstShare` and its tests (`packages/hub/src/index.test.ts`) read
  `dst_share`/`dst_root` from `envelope.params`, not the envelope's top level.
- Wire-format casts at the two deserialization boundaries (`packages/node/src/
  connection.ts`, `packages/hub/src/index.ts`'s `onMessage`) go through `unknown` first
  (`msg as unknown as RpcEnvelope`) rather than a direct `as RpcEnvelope`, since the
  envelope's fields are now fully named and an incoming `Record<string, unknown>` no
  longer structurally overlaps enough for TypeScript to allow a direct cast. This is
  the same trust boundary as before — JSON off the wire was never runtime-validated
  here — just a more honest spelling of it.
