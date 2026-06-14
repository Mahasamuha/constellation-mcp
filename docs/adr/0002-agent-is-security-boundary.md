# ADR 0002: The Node Is the Security Boundary

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The relay sits between MCP clients and the node and handles routing, OAuth, and
path filtering. An early design question was where to locate the authority over which
filesystem paths are accessible: in the relay (centralized), in the node (local), or
split across both.

## Decision

The node is the sole authority over which local filesystem paths are accessible. The
relay can only restrict what reaches the node — it cannot expand it.

Path access is controlled by the node's local `paths.yaml`. The relay resolves a
label name to an `absolute_root` and forwards that root to the node in the RPC
envelope. The node independently validates that root against its own allowlist. A
relay that has been compromised, misconfigured, or acting maliciously cannot instruct
the node to access a path it has not explicitly registered.

Relay-side path filters (`relay_path_filters`) are a deny-only overlay applied
before dispatch. They can restrict what the relay forwards but cannot grant access
to anything the node would reject.

## Rationale

Centralizing path authority in the relay would mean a single compromised component
can read or write any file on any connected node. Distributing authority to the node
means a compromised relay can at most replay or withhold requests — it cannot expand
access. This matches the threat model of a self-hosted personal tool where the user's
local machine is more trusted than any cloud service.

The node always enforces its allowlist independently of what the relay claims. There
is no trust path from relay to node config.

## Alternatives Considered

**Relay-authoritative path registry:** the relay stores the canonical label→path
map and sends the full resolved path to the node, which trusts it blindly. Rejected
because a compromised relay has full filesystem access on any connected node.

**Mutual authorization (both must agree):** both relay and node maintain independent
allowlists and both must permit a path for access to be granted. Redundant for the
self-hosted case and adds operational friction without meaningful additional security
given the node check is already terminal.

## Consequences

- The node's local config (`paths.yaml`) is the ground truth for path enforcement.
  The relay's copy of labels (in Postgres) is used for routing and display only and
  is always derived from what the node pushes on connect.
- Any discrepancy between the relay's label copy and the node's config resolves in
  favor of the node at enforcement time.
- Path-related errors returned to MCP clients are deliberately terse ("Path rejected
  by node") — internal detail (agentId, resolvedPath) is logged for the operator
  only, never forwarded to the caller.
