# Shared Agent

The shared agent is a Constellation agent type for machines shared by multiple users (NAS, dev server, domain-joined host). Unlike the personal agent — which runs under the user's own OS identity and manages their own labels — the shared agent runs as a dedicated service user and dispatches each tool call under the requesting user's OS identity.

---

## 1. Architecture and Design Assumptions

The shared agent model rests on two assumptions:

1. **The broker is a trusted intermediary.** Identity claims forwarded in the RPC envelope arrive from the broker, which authenticated the user via OIDC. The agent trusts these claims as authoritative — the same trust model as SSSD or an LDAP client trusting a directory server.

2. **The admin, not users, controls what is shared.** Labels (path mounts) are defined in the agent config by the operator. Users cannot register, modify, or remove labels. The agent connects to the broker with a service-level token that is not bound to any user.

**Personal vs. shared modality:**

| | Personal agent | Shared agent |
|---|---|---|
| Runs as | The user's own OS identity | A dedicated low-privilege service user |
| Label registry | User-managed (via broker sync) | Admin-defined in config file |
| Token scope | Bound to one user | Service-level (not user-bound) |
| Per-request identity | N/A — always the user | Resolved from OIDC claims in the RPC envelope |
| Sub-process spawning | None | Spawns a subagent per OS user on demand |

---

## 2. Security Model

### Identity resolution (three-tier priority chain)

The shared agent resolves the requesting user's local OS username using a priority chain. The first tier to produce a valid OS account wins; if no tier succeeds, the request is rejected.

1. **Tier 1 — Custom OIDC claims** (`identity.claims` in config): Iterate configured claim names; look up the claim value from the RPC envelope; attempt OS account lookup (`getpwnam`). Suitable for LDAP-backed providers where the directory attribute (e.g. `uid`, `sAMAccountName`) is forwarded as a custom claim via an Authentik property mapping.

2. **Tier 2 — Explicit `oidc_sub` → username map** (`identity.user_map`): Static mapping from provider-assigned subject identifier to local username. Used when custom claims are unavailable or a per-user override is needed.

3. **Tier 3 — `preferred_username` (opt-in, disabled by default)**: Directly resolves the `preferred_username` claim as a local OS username. **Disabled by default** because `preferred_username` is editable by users on many providers (including Authentik with default settings) and can be used for lateral movement. Enable only if your provider locks this claim and you understand the risk.

### Token security

- The service-level token is a root-level credential — it is not user-scoped.
- The token is never stored in the config file. It is read from `CONSTELLATION_AGENT_TOKEN` at startup, optionally sourced from an env file (`env_file` in config).
- The env file should be `0600`, owned by the service user. The agent warns on startup if permissions are too broad.
- **Subagent workers never inherit the parent's environment.** `CONSTELLATION_AGENT_TOKEN` (and anything else read from `env_file`) lives in the shared agent's `process.env`, but each tool call is dispatched to a forked worker that immediately `setuid()`s to the requesting user — a possibly low-trust local account that could read its own `/proc/<pid>/environ`. Spreading `process.env` into that fork would hand the broker token (and any other secret) to that user. Instead, `buildWorkerEnv()` in `packages/agent/src/shared/subagent.ts` constructs an explicit allowlisted environment (`CONSTELLATION_TARGET_*`, `HOME`/`USER`/`LOGNAME` for the *target* user, `PATH`, `LOG_LEVEL`). **If you find a variable isn't propagating to the subagent worker, this is why — add it explicitly to `buildWorkerEnv`, do not change it back to `...process.env`.** See ADR 0014.

### Sub-path access control

The agent controls access at the label (share root) level only. Access to specific files and directories within a label is enforced entirely by the OS filesystem permissions of the subagent running under the user's identity. Operators who need sub-path restrictions should use standard OS permissions (`chmod`, ACLs, supplementary groups) on the underlying paths.

### UID restrictions

The agent refuses to spawn subagents as:
- UID 0 (root) — always blocked, not configurable
- The shared agent's own UID — always blocked
- UIDs outside `subagent_uid.allowed_range` (if configured)
- UIDs within `subagent_uid.blocked_range` (if configured)
- UIDs in `subagent_uid.blocked_uids` (if configured)

See the config reference in §5 for details.

### GID restrictions

UID checks gate on a single value, but a subagent's *effective* privileges
depend on its **entire group membership** — primary group plus every
supplementary group the OS resolves for that account via `initgroups()` at
privilege-drop time (see `subagent-worker.ts`). A user with an unremarkable
primary GID could still be a secondary member of `docker`, `sudo`, or any
group that owns files outside the labels you've configured — none of which the
UID allow/block lists would ever see.

Because group membership is multi-valued, there's no equivalent of
`allowed_range` / a single "blocked GID" that can be trimmed away — the agent
either spawns the subagent with the user's full, OS-resolved group list (the
only option `initgroups()` supports; see ADR 0014) or it doesn't spawn at all.
So **before every dispatch** (not just at first spawn — group membership is
re-resolved on each call so admin changes take effect without restarting the
agent or waiting for a pooled worker to be torn down), the agent resolves the
target user's complete group list and refuses to proceed if *any* member is on
the blocked set:

- GID 0 (`root`'s group) — always blocked, not configurable
- The shared agent's own primary GID — always blocked
- GIDs in `subagent_gid.blocked_gids` (if configured)

If the lookup itself fails (the agent can't enumerate the user's groups), the
agent fails closed and refuses to spawn rather than risk running with
unverified membership.

**What gets logged vs. what gets returned.** When a spawn is blocked for GID
reasons, the agent logs the *full* list of blocked GIDs that triggered the
rejection — tagged with `request_id`, `username`, and `uid` — so an
administrator has a concrete starting point to investigate (check the user's
group memberships with `id <username>` and cross-reference against
`subagent_gid.blocked_gids`, `root`, and the agent's own group). The error
returned to the *caller*, however, intentionally says only that *some* group is
blocked and never names which one(s) — naming them would let a user enumerate
group membership of accounts they don't otherwise have visibility into. The
caller-facing message does include the same `request_id` as a correlation
token, so the user can hand it to an admin who can then grep the agent log /
audit log for the matching entry and see exactly what was blocked:

```
Access denied: one or more of your OS groups are blocked by the shared agent
administrator. Contact your administrator with reference ID: <request_id>
```

See the config reference in §5 for details.

---

## 3. Request Flow

```
MCP client
  → POST /mcp (Bearer token)
    → Broker authenticates session → retrieves userId, oidcSub, lastKnownClaims
    → Broker resolves label → checks SharedPathLabel registry (optimistic permission check)
    → Broker builds RPC envelope: { tool, label, absolute_root, user_oidc_sub, user_claims, ...params }
    → Broker forwards RPC via WebSocket to shared agent
      → Shared agent resolves OS identity (3-tier chain)
      → Shared agent checks permissions (label-level access against admin config)
      → Shared agent looks up or spawns subagent for resolved user
        → Subagent runs under user's OS identity (uid + full supplementary groups via initgroups)
        → Subagent executes tool via AgentExecutor
        → Subagent sends SubagentResponse to parent
      → Shared agent writes audit log entry
      → Shared agent sends RPC response to broker
    → Broker returns result to MCP client
```

Two enforcement points:
- **Broker (optimistic):** evaluates the synced permission blob (`default` access and per-`oidc_sub` overrides) at label resolution time. May grant access that the agent subsequently denies (e.g. due to Tier 1 identity resolution failure).
- **Agent (authoritative):** full identity resolution and permission check. Result at the agent always takes precedence.

---

## 4. Permission Model

Permissions are defined per-label in the config. The evaluation order:

1. If the label is not in the admin config → reject.
2. If `permissions.overrides` contains an entry for the user's `oidc_sub` → use that access level.
3. Otherwise use `permissions.default`.

Access levels:
- `read-only` — permits read, search, and listing tools; blocks write tools (`write_file`, `edit_file`, `create_directory`, `delete`, `move`, `copy`).
- `read-write` — permits all tools.
- `none` — rejects all access; label is hidden in discovery.

---

## 5. Deployment

### Prerequisites

- Linux (Windows support is deferred).
- A dedicated low-privilege service user (e.g. `constellation`) with `CAP_SETUID` and `CAP_SETGID` capabilities. **Do not run as root.**
- An OIDC provider configured to forward a stable user attribute as a claim (Tier 1 identity), or a static `user_map` (Tier 2).
- An audit log directory writable by the service user.

### Registration

Register the shared agent with the broker using the device code flow (preferred):

```sh
constellation shared-agent register \
  --broker-url https://broker.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/shared-agent.env
```

The browser opens automatically for admin approval. The token is written to the env file — the operator never sees the raw token.

Options:
- `--broker-url` — required (or set `BROKER_URL`)
- `--host-name` — defaults to `hostname()`; used as the agent's display name in the broker
- `--env-file` — where to write `CONSTELLATION_AGENT_TOKEN` (default: `/etc/constellation/shared-agent.env`)

Break-glass alternative (scripted provisioning or token recovery):

```sh
constellation broker token create --shared
# Requires admin session (run 'constellation broker elevate' first)
```

The token is displayed once and must be stored immediately.

### Config file

Minimum config (`/etc/constellation/shared-agent.yaml`):

```yaml
broker_url: wss://broker.example.com
agent_name: nas-shared
audit_log: /var/log/constellation/shared-agent-audit.jsonl
env_file: /etc/constellation/shared-agent.env

labels:
  - name: projects
    path: /srv/projects
    instructions: "Shared engineering workspace — read-only outside business hours."
    permissions:
      default: read-write

identity:
  claims:
    - constellation_username
```

Full config reference:

```yaml
# Required
broker_url: wss://broker.example.com       # WebSocket URL of the broker
agent_name: nas-shared                     # Display name in the broker UI
audit_log: /var/log/constellation/shared-agent-audit.jsonl

# Optional
env_file: /etc/constellation/shared-agent.env  # Source CONSTELLATION_AGENT_TOKEN from this file
subagent_idle_timeout_seconds: 300         # Kill idle subagent workers after N seconds (default: 300)
subagent_rpc_timeout_seconds: 30           # Timeout per tool call (default: 30)

subagent_uid:
  allowed_range:
    min: 1000                              # Only spawn subagents for UIDs >= 1000
    max: 65534
  blocked_range:
    min: 60000                             # Block UIDs in this range even if in allowed_range
    max: 65534
  blocked_uids: [999]                      # Block specific UIDs

subagent_gid:
  blocked_gids: [27, 999]                  # Block subagents whose user belongs to ANY of these
                                           # groups (e.g. 27 = `sudo` on Debian/Ubuntu). Membership
                                           # is resolved via the full OS group list (primary +
                                           # supplementary), not just the user's primary GID.
                                           # GID 0 (root) and the agent's own GID are always
                                           # blocked, regardless of this list.

labels:
  - name: projects
    path: /srv/projects
    instructions: "Optional text surfaced to MCP clients via list_labels"
                                           # Hard cap: 500 chars (longer values are dropped with a
                                           # warning). Recommended: keep under 250 — this should give
                                           # light context/framing for the label, not document it or
                                           # serve as a heavy instruction set.
    context_file: /etc/constellation/projects-instructions.txt
                                           # Optional. Absolute path to a text/markdown file read at
                                           # sync time and used as `instructions` (same 500-char cap)
                                           # when no inline `instructions` is set. `instructions` takes
                                           # precedence when both are present. If missing or unreadable
                                           # at sync time, instructions is omitted for that sync (logged
                                           # at info level) rather than causing an error.
    permissions:
      default: read-write                  # read-only | read-write | none
      overrides:
        - oidc_sub: auth0|abc123           # Per-user access override
          access: read-only

identity:
  claims:
    - constellation_username               # OIDC claim names to try (Tier 1)
  user_map:
    - oidc_sub: auth0|abc123              # Tier 2: explicit oidc_sub → local username map
      local_username: alice
  allow_preferred_username: false          # Tier 3: use preferred_username claim (risky — see §2)
```

### Systemd unit

Generate the unit file:

```sh
constellation shared-agent install \
  --config-file /etc/constellation/shared-agent.yaml \
  --user constellation \
  --unit-name constellation-shared-agent
```

This prints the unit to stdout followed by install instructions. Follow the printed steps to install and enable the service.

Options:
- `--config-file` — path to config file (default: `/etc/constellation/shared-agent.yaml`, or `$CONSTELLATION_SHARED_AGENT_CONFIG`)
- `--user` — service user (default: `constellation`); must have `CAP_SETUID`/`CAP_SETGID`
- `--unit-name` — systemd unit name (default: `constellation-shared-agent`)

The generated unit sets `AmbientCapabilities=CAP_SETUID CAP_SETGID`, `CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, `NoNewPrivileges=no`, `ProtectSystem=strict`, and `ReadWritePaths=/var/log/constellation`.

### Start / stop

```sh
# Start (direct, non-systemd)
constellation shared-agent start --config-file /etc/constellation/shared-agent.yaml

# Via systemd
sudo systemctl start constellation-shared-agent
sudo systemctl stop constellation-shared-agent

# Stop shortcut (calls systemctl stop)
constellation shared-agent stop --unit-name constellation-shared-agent
```

`--config-file` defaults to `/etc/constellation/shared-agent.yaml`, overridable via `CONSTELLATION_SHARED_AGENT_CONFIG` or the flag itself — all `shared-agent` subcommands resolve it the same way.

---

## 6. Operator Runbook

### Validate config before starting

```sh
constellation shared-agent validate-config --config-file /etc/constellation/shared-agent.yaml
```

Checks: required fields are present; label paths exist on disk; `user_map` usernames resolve locally; UID range bounds are consistent; token is available (env or env_file).

### Show running config summary

```sh
constellation shared-agent status --config-file /etc/constellation/shared-agent.yaml
constellation shared-agent status --config-file /etc/constellation/shared-agent.yaml --json
```

### Apply a config change

Config changes require a full restart — there is no live reload:

```sh
sudo systemctl restart constellation-shared-agent
```

### Rotate the service token

```sh
constellation shared-agent rotate-token --config-file /etc/constellation/shared-agent.yaml
sudo systemctl restart constellation-shared-agent
```

The command connects to the broker via WebSocket, requests a new token, and writes it to `env_file`. The agent must be restarted to reconnect with the new token.

### Revoke a shared agent

```sh
# Get the agent ID from the broker:
constellation broker agents list --json

# Revoke:
constellation broker agents revoke <agent-id>
```

The agent goes offline immediately. To re-register, run `constellation shared-agent register` again (requires admin approval).

### Audit log

Each tool call produces one JSONL entry:

```json
{
  "ts": "2026-06-06T12:00:00.000Z",
  "agent_name": "nas-shared",
  "request_id": "<uuid>",
  "user_oidc_sub": "auth0|abc123",
  "local_username": "alice",
  "label": "projects",
  "tool": "read_file",
  "outcome": "ok",
  "error": null
}
```

`outcome` values: `ok` | `identity_error` | `permission_denied` | `exec_error`.

Rotate logs with `logrotate`. The agent does not rotate logs itself.

### Inspect shared labels (admin)

View the full shared label registry including permission configs:

```sh
constellation broker shared-labels list
constellation broker shared-labels list --agent <agent-id>
constellation broker shared-labels list --json
```

Requires an elevated admin session (`constellation broker elevate`).
