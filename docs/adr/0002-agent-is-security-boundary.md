# ADR 0002: The Agent Is the Security Boundary

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The broker sits between MCP clients and the agent and handles routing, OAuth, and
path filtering. An early design question was where to locate the authority over which
filesystem paths are accessible: in the broker (centralized), in the agent (local), or
split across both.

## Decision

The agent is the sole authority over which local filesystem paths are accessible. The
broker can only restrict what reaches the agent — it cannot expand it.

Path access is controlled by the agent's local `paths.yaml`. The broker resolves a
label name to an `absolute_root` and forwards that root to the agent in the RPC
envelope. The agent independently validates that root against its own allowlist. A
broker that has been compromised, misconfigured, or acting maliciously cannot instruct
the agent to access a path it has not explicitly registered.

Broker-side path filters (`broker_path_filters`) are a deny-only overlay applied
before dispatch. They can restrict what the broker forwards but cannot grant access
to anything the agent would reject.

## Rationale

Centralizing path authority in the broker would mean a single compromised component
can read or write any file on any connected agent. Distributing authority to the agent
means a compromised broker can at most replay or withhold requests — it cannot expand
access. This matches the threat model of a self-hosted personal tool where the user's
local machine is more trusted than any cloud service.

The agent always enforces its allowlist independently of what the broker claims. There
is no trust path from broker to agent config.

## Alternatives Considered

**Broker-authoritative path registry:** the broker stores the canonical label→path
map and sends the full resolved path to the agent, which trusts it blindly. Rejected
because a compromised broker has full filesystem access on any connected agent.

**Mutual authorization (both must agree):** both broker and agent maintain independent
allowlists and both must permit a path for access to be granted. Redundant for the
self-hosted case and adds operational friction without meaningful additional security
given the agent check is already terminal.

## Consequences

- The agent's local config (`paths.yaml`) is the ground truth for path enforcement.
  The broker's copy of labels (in Postgres) is used for routing and display only and
  is always derived from what the agent pushes on connect.
- Any discrepancy between the broker's label copy and the agent's config resolves in
  favor of the agent at enforcement time.
- Path-related errors returned to MCP clients are deliberately terse ("Path rejected
  by agent") — internal detail (agentId, resolvedPath) is logged for the operator
  only, never forwarded to the caller.
