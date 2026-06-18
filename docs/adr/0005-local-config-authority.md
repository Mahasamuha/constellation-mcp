# ADR 0005: Node Config Is Local Authority; Relay Config Is Derived

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The node needs to tell the relay which path shares it has registered so the relay
can route MCP tool calls to the correct node. This creates two possible sources of
truth for the share registry: the relay's Postgres store, or the node's local
`paths.yaml`.

## Decision

The node's local `paths.yaml` is the sole authoritative source for share
definitions. The relay stores a copy of share→path mappings in Postgres for routing
and display, but that copy is always derived from what the node pushes — it is never
authoritative.

On every WebSocket connection, the node immediately sends a `config_update` message
containing its current share registry. The relay upserts those shares in Postgres:
adding new ones, updating paths on existing ones, and removing any not present in the
payload. This keeps routing information current without a restart.

If the relay's copy diverges from the node's local config (e.g. after a relay
restart, DB corruption, or a race), the node's config wins at enforcement time.

## Rationale

Making the relay authoritative for share config would require the relay to survive
as the source of truth for user configuration. This adds operational burden (backup
requirements for share config, migration risk) and creates a failure mode where the
relay's records are wrong and the node behaves unexpectedly. Local config is always
accessible to the user, versioned with their dotfiles, and survives relay replacement.

Reconnection simplicity is also a factor: because config is local, a node reconnect
is stateless — it just pushes its current config on connect. No sync protocol, no
conflict resolution.

## Alternatives Considered

**Relay-authoritative registry with node sync:** shares are defined and stored in
the relay; the node pulls them on connect. Rejected because it makes the relay
a single point of failure for the share map and complicates node setup (how does the
node bootstrap its first config before it has a relay connection?).

**Split authority (user defines in both):** rejected as too complex and likely to
diverge in confusing ways.

## Consequences

- `paths.yaml` is the node's config file. It is read at startup. The node does not
  watch it for changes; `constellation node sync` or `node paths add/remove` must
  be used to push mid-session changes.
- The relay's `path_shares` table is informational for routing. It must not be used
  as the source of truth for what the node will accept — the node's runtime
  validation (against `paths.yaml`) is terminal.
- `constellation node sync` sends a fresh `config_update` mid-session after a manual
  config edit. `node paths add` and `node paths remove` sync immediately.
- Share names must be unique per user across all nodes (enforced at the relay).
  Conflicts are returned as a structured error to the node on `config_update`.
