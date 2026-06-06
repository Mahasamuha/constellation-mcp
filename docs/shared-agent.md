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

labels:
  - name: projects
    path: /srv/projects
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
  --config /etc/constellation/shared-agent.yaml \
  --user constellation \
  --unit-name constellation-shared-agent
```

This prints the unit to stdout followed by install instructions. Follow the printed steps to install and enable the service.

Options:
- `--config` — required; path to config file
- `--user` — service user (default: `constellation`); must have `CAP_SETUID`/`CAP_SETGID`
- `--unit-name` — systemd unit name (default: `constellation-shared-agent`)

The generated unit sets `AmbientCapabilities=CAP_SETUID CAP_SETGID`, `CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, and `NoNewPrivileges=no`.

### Start / stop

```sh
# Start (direct, non-systemd)
constellation shared-agent start --config /etc/constellation/shared-agent.yaml

# Via systemd
sudo systemctl start constellation-shared-agent
sudo systemctl stop constellation-shared-agent

# Stop shortcut (calls systemctl stop)
constellation shared-agent stop --unit-name constellation-shared-agent
```

`start` also reads `CONSTELLATION_SHARED_AGENT_CONFIG` from the environment as a fallback for `--config`.

---

## 6. Operator Runbook

### Validate config before starting

```sh
constellation shared-agent validate-config --config /etc/constellation/shared-agent.yaml
```

Checks: required fields are present; label paths exist on disk; `user_map` usernames resolve locally; UID range bounds are consistent; token is available (env or env_file).

### Show running config summary

```sh
constellation shared-agent status --config /etc/constellation/shared-agent.yaml
constellation shared-agent status --config /etc/constellation/shared-agent.yaml --json
```

### Apply a config change

Config changes require a full restart — there is no live reload:

```sh
sudo systemctl restart constellation-shared-agent
```

### Rotate the service token

```sh
constellation shared-agent rotate-token --config /etc/constellation/shared-agent.yaml
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
