# ADR 0005: Agent Config Is Local Authority; Broker Config Is Derived

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The agent needs to tell the broker which path labels it has registered so the broker
can route MCP tool calls to the correct agent. This creates two possible sources of
truth for the label registry: the broker's Postgres store, or the agent's local
`paths.yaml`.

## Decision

The agent's local `paths.yaml` is the sole authoritative source for label
definitions. The broker stores a copy of label→path mappings in Postgres for routing
and display, but that copy is always derived from what the agent pushes — it is never
authoritative.

On every WebSocket connection, the agent immediately sends a `config_update` message
containing its current label registry. The broker upserts those labels in Postgres:
adding new ones, updating paths on existing ones, and removing any not present in the
payload. This keeps routing information current without a restart.

If the broker's copy diverges from the agent's local config (e.g. after a broker
restart, DB corruption, or a race), the agent's config wins at enforcement time.

## Rationale

Making the broker authoritative for label config would require the broker to survive
as the source of truth for user configuration. This adds operational burden (backup
requirements for label config, migration risk) and creates a failure mode where the
broker's records are wrong and the agent behaves unexpectedly. Local config is always
accessible to the user, versioned with their dotfiles, and survives broker replacement.

Reconnection simplicity is also a factor: because config is local, an agent reconnect
is stateless — it just pushes its current config on connect. No sync protocol, no
conflict resolution.

## Alternatives Considered

**Broker-authoritative registry with agent sync:** labels are defined and stored in
the broker; the agent pulls them on connect. Rejected because it makes the broker
a single point of failure for the label map and complicates agent setup (how does the
agent bootstrap its first config before it has a broker connection?).

**Split authority (user defines in both):** rejected as too complex and likely to
diverge in confusing ways.

## Consequences

- `paths.yaml` is the agent's config file. It is read at startup. The agent does not
  watch it for changes; `constellation agent sync` or `agent paths add/remove` must
  be used to push mid-session changes.
- The broker's `path_labels` table is informational for routing. It must not be used
  as the source of truth for what the agent will accept — the agent's runtime
  validation (against `paths.yaml`) is terminal.
- `constellation agent sync` sends a fresh `config_update` mid-session after a manual
  config edit. `agent paths add` and `agent paths remove` sync immediately.
- Label names must be unique per user across all agents (enforced at the broker).
  Conflicts are returned as a structured error to the agent on `config_update`.
