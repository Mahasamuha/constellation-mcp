# ADR 0011: Shared Label Discovery Is Optimistic (Not Authoritative)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

Users connected to a hub need a way to discover which labels are available
to them without requiring out-of-band coordination with the admin. The relay already
holds a synced copy of the hub's label registry (including permission config).
The question is whether discovery results should be guaranteed accurate or allowed to
be approximate.

## Decision

Shared label discovery is optimistic. The relay evaluates its synced copy of the
permission config to determine which labels to show a user. The result is not
authoritative — a label appearing in discovery may be rejected at dispatch if the hub's
live config has changed since the last sync, or if Tier 1 identity resolution (custom
claims) maps the user to a blocked OS account.

**What the relay can evaluate from synced config:**
- `default` access level (applies to any user not in `overrides`)
- Per-`oidc_sub` overrides (the relay has `oidcSub` on the `User` row)

**What the relay cannot evaluate:**
- Tier 1 identity resolution (custom OIDC claims → local OS username) — happens on
  the hub only
- Group-based permissions — not in the current permission model

**Visibility rule:** a label is included in discovery results if and only if the
relay's optimistic evaluation yields an access level other than `none`. Labels that
evaluate to `none` are hidden entirely — their existence is not revealed.

Discovery is backed by `SharedPathLabel` in Postgres, populated by the hub on
connect and on restart. No hub round-trip at query time.

The `list_available_labels` MCP tool availability is controlled by a `list_labels_tool`
relay config field: `disabled` | `advertised` (default) | `enabled`. The `advertised`
default means AI clients can discover the tool exists and prompt users to enable it,
without it being silently absent.

## Rationale

Authoritative discovery would require the relay to round-trip to the hub at every
discovery query to evaluate Tier 1 claims in real time. This adds latency and a liveness
dependency (discovery fails if the hub is offline) for a query that is naturally
read-heavy and low-stakes. The primary cost of optimistic discovery is the occasional
false positive — a label appears available but is rejected at dispatch. This mirrors how
NFS/Samba browse lists work and is acceptable.

The converse (a label the user can access not appearing in discovery) can occur when
Tier 1 grants access on a `default: none` label — Tier 1 resolution is hub-side only
and invisible to the relay. This is documented as a known limitation, not a bug.

## Alternatives Considered

**Authoritative discovery via hub round-trip:** requires the hub to be online for
discovery, adds per-query latency, and requires the relay to forward full OIDC claim
sets to the hub at discovery time. Rejected for the reasons above.

**No relay-side discovery (always query the hub directly):** MCP clients would need to
know which hubs to query and construct per-hub queries. Rejected — the relay is
the aggregation point.

## Consequences

- A user may see a label in `list_available_labels` that is subsequently rejected at
  dispatch. The dispatch error is informative (identity resolution failure or permission
  denied), not a protocol error.
- The admin label listing CLI (`constellation relay shared-labels list`, with backing
  `GET /api/admin/shared-labels` endpoint, admin-gated) provides a full view of the
  shared label registry including inaccessible labels. This is the primary
  troubleshooting tool for permission misconfigurations.
- Discovery results are served from `SharedPathLabel` in Postgres. Stale data (hub
  config changed between syncs) results in stale discovery — not a security issue since
  enforcement is always at the hub.
- The `SharedPathLabel` table stores the `permissionBlob` as JSON — the full label
  permission config as received from the hub. The relay evaluates this blob
  at discovery query time.
