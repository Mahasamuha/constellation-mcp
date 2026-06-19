# ADR 0016: Queue Timeout Utility Lives in `@constellation/shared`, Not Hub

**Status:** Accepted  
**Date:** 2026-06-15

## Context

The hub's worker pool (`packages/hub/src/subnode.ts`) queues incoming requests
when all workers for a user are busy and the pool is at capacity. Each queued
entry carries a deadline computed from a `queue_timeout` config value. That
value is interpreted as either:

- a **float** — a fraction of `subnode_rpc_timeout_seconds` (e.g. `0.5` → half
  the RPC timeout), or
- an **integer** — an explicit number of seconds, clamped to
  `subnode_rpc_timeout_seconds`.

This interpretation (`resolveQueueTimeout`) is a small, pure function with no
dependency on hub-specific types. The question was whether to keep it inline in
`packages/hub/src/config.ts` or extract it to `packages/shared`.

`packages/node` currently dispatches each RPC call directly in-process via
`FileExecutor` with no concurrency control. For the single-user case this is
sufficient, but if node gains a configurable concurrency limit in the future,
it will need the same queue-timeout mechanic: a config value that expresses
"how long a request waits for a slot" as either a fraction of the RPC timeout
or an explicit number of seconds.

## Decision

`resolveQueueTimeout(queueTimeout: number, rpcTimeoutMs: number): number` is
implemented in `packages/shared/src/queue-timeout.ts` and imported by hub.

The file carries a comment stating that `packages/node` is the intended future
consumer and that this utility must not be inlined back into hub.

## Rationale

If the utility stays in hub, node would have to either duplicate the logic or
take a dependency on hub internals to reuse it — both bad outcomes. The function
is three lines with no external dependencies; the cost of putting it in shared
is negligible.

The file-level comment exists because the utility looks trivially simple and is
easy to "clean up" back into its only current caller. The comment makes the
architectural intent explicit so future contributors don't mistake the placement
for an oversight.

## Alternatives Considered

**Inline in `packages/hub/src/config.ts`:** simpler for hub today, but forces
duplication or a hub dependency when node needs it. Rejected.

**Inline in both hub and node when node needs it:** avoids premature abstraction
but requires remembering to keep two implementations in sync. Rejected — the
function's semantics are non-obvious enough (float vs. integer distinction,
clamping behavior) that drift is a real risk.

## Consequences

- `resolveQueueTimeout` must not be moved back into hub, even if node never
  ends up using it. The shared placement is an architectural stake in the ground
  about where concurrency-limit config parsing belongs.
- When node gains concurrency limiting, it should import `resolveQueueTimeout`
  from `@constellation/shared` and add its own `queue_timeout` config key with
  the same semantics.
- The function's float/integer edge case (`1.0` in YAML parses as integer `1`,
  so `1.0` means "1 second," not "100% of RPC timeout") must be documented in
  both `docs/hub.md` and any future `docs/node.md` config reference.