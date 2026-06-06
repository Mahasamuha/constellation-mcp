# ADR 0001: Do Not Share RpcEnvelope Across Agent and Broker

**Status:** Accepted  
**Date:** 2026-06-06

## Context

`RpcEnvelope` is defined independently in two packages:

- `packages/agent/src/rpc.ts` — `{ request_id, tool, absolute_root, [key]: unknown }`
- `packages/broker/src/hub.ts` — `{ request_id, tool, absolute_root, user_oidc_sub, user_claims, [key]: unknown }`

When consolidating cross-package types into `@constellation/shared`, `RpcEnvelope` was
identified as a candidate because both packages define it and it represents the core
wire protocol between broker and agent.

## Decision

`RpcEnvelope` will **not** be moved to `@constellation/shared`.

## Rationale

The two definitions are intentionally different. The broker adds `user_oidc_sub` and
`user_claims` to the envelope before forwarding it to the agent. These fields are
injected at dispatch time from the authenticated OAuth session and are not present in
the original MCP tool call.

Merging them into a single shared type would require making those fields optional
(`user_oidc_sub?: string | null`, `user_claims?: Record<string, unknown>`), which
loses the type-level guarantee that the agent always receives them when it needs them
for identity resolution. The broker's envelope is a strict superset of the agent's —
they are different stages of the same message, not the same type.

Merging them would also collapse a meaningful semantic boundary: the broker's
`RpcEnvelope` is the outbound dispatch contract (broker guarantees these fields are
set); the agent's is the inbound receipt contract (agent relies on them being present).
Optional fields on a shared type would make both contracts weaker without benefit.

## Alternatives Considered

**Subtype approach (`AgentRpcEnvelope extends RpcEnvelope`):** would preserve the
type guarantee but adds indirection. The two types are small and stable; the indirection
buys little.

**Single type with required fields:** would require the agent's side to also produce
`user_oidc_sub` and `user_claims`, which is not its responsibility. Rejected.

## Consequences

- `RpcEnvelope` remains defined locally in each package.
- If fields are added to the wire format, both definitions must be updated in sync.
  This is acceptable given the stability of the envelope and the clarity gained by
  keeping the broker/agent contracts explicit.
- `RpcError`, `RpcResponse`, and `PathEntry` — which are identical across packages —
  were consolidated into `@constellation/shared` as part of the same review.
