# ADR 0012: In-Memory Rate Limiting (No Redis for v1)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The broker needs rate limiting on MCP tool calls, expensive tools, OAuth endpoints,
and agent WebSocket reconnects to prevent abuse and runaway load. The question was
whether to implement rate limiting with an in-memory sliding window or an external
store (Redis).

## Decision

Rate limiting is implemented in-memory using sliding windows. No Redis is required.
Rate limit state is lost on broker restart, which is acceptable.

| Surface | Default | Config variable |
|---|---|---|
| MCP tool calls | 60 req/min per user | `RATE_LIMIT_TOOL_CALLS_PER_MIN` |
| Expensive tools (`grep_files`, `find_files`, recursive `list_directory`) | 20 req/min per user | `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN` |
| OAuth endpoints | 10 req/15 min per IP | `RATE_LIMIT_OAUTH_PER_15MIN` |
| Device code polling | 200 req/15 min per IP | `RATE_LIMIT_DEVICE_POLL_PER_15MIN` |
| Agent WebSocket reconnects | 10 req/min per agent token | `RATE_LIMIT_WS_RECONNECT_PER_MIN` |

Implementation: `express-rate-limit` for HTTP/OAuth surfaces; a lightweight custom
sliding-window map for WebSocket reconnects.

## Rationale

Constellation v1 is designed for single-instance deployment. Redis introduces an
external dependency, additional operational complexity (version, connection management,
memory configuration), and latency for every rate-limited check. For a single-instance
broker serving a personal or small-team workload, in-memory limits are sufficient.

Losing rate limit state on restart is acceptable because: (1) restarts are infrequent;
(2) a brief reset of counters is not a meaningful security regression for the use case;
(3) the limits themselves are conservative enough that the window-reset exploit is not
practical.

The primary protection against sustained abuse is at the infrastructure layer (WAF,
reverse proxy) — the broker's rate limits are a secondary defense appropriate to its
operational context.

## Alternatives Considered

**Redis-backed rate limiting:** accurate across restarts and horizontally scalable.
Rejected for v1 because it adds a hard infrastructure dependency for a feature that
is "good enough" with in-memory state for the single-instance case. Noted as the
migration path when horizontal scaling is needed (see `future-deferred.md`).

**No rate limiting:** rejected. Runaway `grep_files` calls on large trees or
credential-stuffing attempts on OAuth endpoints are realistic abuse vectors even for
personal deployments.

## Consequences

- Rate limit state resets on broker restart. Not a security issue for the intended
  deployment context.
- The in-memory approach is the horizontal scaling blocker alongside the WebSocket
  connection map. Both are documented as single-instance constraints with clear
  migration paths.
- All limits are tunable via broker environment variables — operators with higher-load
  deployments can adjust without a code change.
- Sustained flood mitigation (DDoS-scale attacks on `/oauth/register`) belongs at the
  infrastructure layer (WAF, reverse proxy) and is explicitly out of scope for the
  broker itself.
