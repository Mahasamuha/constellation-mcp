# Hub

A hub is a Constellation deployment for machines shared by multiple users (NAS, dev server, domain-joined host). Unlike a node — which runs under the user's own OS identity and manages its own labels — the hub runs as a dedicated service user and dispatches each tool call under the requesting user's OS identity.

---

## 1. Architecture and Design Assumptions

The hub model rests on two assumptions:

1. **The relay is a trusted intermediary.** Identity claims forwarded in the RPC envelope arrive from the relay, which authenticated the user via OIDC. The hub trusts these claims as authoritative — the same trust model as SSSD or an LDAP client trusting a directory server.

2. **The admin, not users, controls what is shared.** Labels (path mounts) are defined in the hub config by the operator. Users cannot register, modify, or remove labels. The hub connects to the relay with a service-level token that is not bound to any user.

**Node vs. hub:**

| | Node | Hub |
|---|---|---|
| Runs as | The user's own OS identity | A dedicated low-privilege service user |
| Label registry | User-managed (via relay sync) | Admin-defined in config file |
| Token scope | Bound to one user (`ExecutorTokenType.NODE`) | Service-level (`ExecutorTokenType.HUB`, not user-bound) |
| Per-request identity | N/A — always the user | Resolved from OIDC claims in the RPC envelope |
| Sub-process spawning | None | Spawns a subnode per OS user on demand |

---

## 2. Security Model

### Identity resolution (three-tier priority chain)

The hub resolves the requesting user's local OS username using a priority chain. The first tier to produce a valid OS account wins; if no tier succeeds, the request is rejected.

1. **Tier 1 — Custom OIDC claims** (`identity.claims` in config): Iterate configured claim names; look up the claim value from the RPC envelope; attempt OS account lookup (`getpwnam`). Suitable for LDAP-backed providers where the directory attribute (e.g. `uid`, `sAMAccountName`) is forwarded as a custom claim via an Authentik property mapping.

2. **Tier 2 — Explicit `oidc_sub` → username map** (`identity.user_map`): Static mapping from provider-assigned subject identifier to local username. Used when custom claims are unavailable or a per-user override is needed.

3. **Tier 3 — `preferred_username` (opt-in, disabled by default)**: Directly resolves the `preferred_username` claim as a local OS username. **Disabled by default** because `preferred_username` is editable by users on many providers (including Authentik with default settings) and can be used for lateral movement. Enable only if your provider locks this claim and you understand the risk.

### Token security

- The service-level token is a root-level credential — it is not user-scoped.
- The token is never stored in the config file. It is read from `CONSTELLATION_HUB_TOKEN` at startup, optionally sourced from an env file (`env_file` in config).
- The env file should be `0600`, owned by the service user. The hub warns on startup if permissions are too broad.
- **Subnode workers never inherit the parent's environment.** `CONSTELLATION_HUB_TOKEN` (and anything else read from `env_file`) lives in the hub's `process.env`, but each tool call is dispatched to a forked worker that immediately `setuid()`s to the requesting user — a possibly low-trust local account that could read its own `/proc/<pid>/environ`. Spreading `process.env` into that fork would hand the hub token (and any other secret) to that user. Instead, `buildWorkerEnv()` in `packages/hub/src/subnode.ts` constructs an explicit allowlisted environment (`CONSTELLATION_TARGET_*`, `HOME`/`USER`/`LOGNAME` for the *target* user, `PATH`, `LOG_LEVEL`). **If you find a variable isn't propagating to the subnode worker, this is why — add it explicitly to `buildWorkerEnv`, do not change it back to `...process.env`.** See ADR 0014.

### Sub-path access control

The hub controls access at the label (share root) level only. Access to specific files and directories within a label is enforced entirely by the OS filesystem permissions of the subnode running under the user's identity. Operators who need sub-path restrictions should use standard OS permissions (`chmod`, ACLs, supplementary groups) on the underlying paths.

### UID restrictions

The hub refuses to spawn subnodes as:
- UID 0 (root) — always blocked, not configurable
- The hub's own UID — always blocked
- UIDs outside `subnode_uid.allowed_range` (if configured)
- UIDs within `subnode_uid.blocked_range` (if configured)
- UIDs in `subnode_uid.blocked_uids` (if configured)

See the config reference in §5 for details.

### GID restrictions

UID checks gate on a single value, but a subnode's *effective* privileges
depend on its **entire group membership** — primary group plus every
supplementary group the OS resolves for that account via `initgroups()` at
privilege-drop time (see `subnode-worker.ts`). A user with an unremarkable
primary GID could still be a secondary member of `docker`, `sudo`, or any
group that owns files outside the labels you've configured — none of which the
UID allow/block lists would ever see.

Because group membership is multi-valued, there's no equivalent of
`allowed_range` / a single "blocked GID" that can be trimmed away — the hub
either spawns the subnode with the user's full, OS-resolved group list (the
only option `initgroups()` supports; see ADR 0014) or it doesn't spawn at all.
So **before every dispatch** (not just at first spawn — group membership is
re-resolved on each call so admin changes take effect without restarting the
hub or waiting for a pooled worker to be torn down), the hub resolves the
target user's complete group list and refuses to proceed if *any* member is on
the blocked set:

- GID 0 (`root`'s group) — always blocked, not configurable
- The hub's own primary GID — always blocked
- GIDs in `subnode_gid.blocked_gids` (if configured)

If the lookup itself fails (the hub can't enumerate the user's groups), the
hub fails closed and refuses to spawn rather than risk running with
unverified membership.

**What gets logged vs. what gets returned.** When a spawn is blocked for GID
reasons, the hub logs the *full* list of blocked GIDs that triggered the
rejection — tagged with `request_id`, `username`, and `uid` — so an
administrator has a concrete starting point to investigate (check the user's
group memberships with `id <username>` and cross-reference against
`subnode_gid.blocked_gids`, `root`, and the hub's own group). The error
returned to the *caller*, however, intentionally says only that *some* group is
blocked and never names which one(s) — naming them would let a user enumerate
group membership of accounts they don't otherwise have visibility into. The
caller-facing message does include the same `request_id` as a correlation
token, so the user can hand it to an admin who can then grep the hub log /
audit log for the matching entry and see exactly what was blocked:

```
Access denied: one or more of your OS groups are blocked by the hub administrator. Contact your administrator with reference ID: <request_id>
```

See the config reference in §5 for details.

---

## 3. Request Flow

```
MCP client
  → POST /mcp (Bearer token)
    → Relay authenticates session → retrieves userId, oidcSub, lastKnownClaims
    → Relay resolves label → checks SharedPathLabel registry (optimistic permission check)
    → Relay builds RPC envelope: { tool, label, absolute_root, user_oidc_sub, user_claims, ...params }
    → Relay forwards RPC via WebSocket to hub
      → Hub resolves OS identity (3-tier chain)
      → Hub checks permissions (label-level access against admin config)
      → Hub looks up or spawns subnode for resolved user
        → Subnode runs under user's OS identity (uid + full supplementary groups via initgroups)
        → Subnode executes tool via FileExecutor
        → Subnode sends SubnodeResponse to parent
      → Hub writes audit log entry
      → Hub sends RPC response to relay
    → Relay returns result to MCP client
```

Two enforcement points:
- **Relay (optimistic):** evaluates the synced permission blob (`default` access and per-`oidc_sub` overrides) at label resolution time. May grant access that the hub subsequently denies (e.g. due to Tier 1 identity resolution failure).
- **Hub (authoritative):** full identity resolution and permission check. Result at the hub always takes precedence.

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

Register the hub with the relay using the device code flow (preferred):

```sh
sudo constellation hub register \
  --relay-url https://relay.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/hub.env
```

The browser opens automatically for admin approval. The token is written to the env file — the operator never sees the raw token.

Options:
- `--relay-url` — required (or set `RELAY_URL`)
- `--host-name` — defaults to `hostname()`; used as the hub's display name in the relay
- `--env-file` — where to write `CONSTELLATION_HUB_TOKEN` (default: `/etc/constellation/hub.env`)

Break-glass alternative (scripted provisioning or token recovery):

```sh
constellation relay token create --shared
# Requires admin session (run 'constellation relay elevate' first)
```

The token is displayed once and must be stored immediately.

### Config file

Minimum config (`/etc/constellation/hub.yaml`):

```yaml
relay_url: wss://relay.example.com
hub_name: nas-shared
audit_log: /var/log/constellation/hub-audit.jsonl
env_file: /etc/constellation/hub.env

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
relay_url: wss://relay.example.com         # WebSocket URL of the relay
hub_name: nas-shared                       # Display name in the relay UI
audit_log: /var/log/constellation/hub-audit.jsonl

# Optional
env_file: /etc/constellation/hub.env       # Source CONSTELLATION_HUB_TOKEN from this file
subnode_idle_timeout_seconds: 300          # Kill idle subnode workers after N seconds (default: 300)
subnode_rpc_timeout_seconds: 30            # Timeout per tool call (default: 30)

subnode_uid:
  allowed_range:
    min: 1000                              # Only spawn subnodes for UIDs >= 1000
    max: 65534
  blocked_range:
    min: 60000                             # Block UIDs in this range even if in allowed_range
    max: 65534
  blocked_uids: [999]                      # Block specific UIDs

subnode_gid:
  blocked_gids: [27, 999]                  # Block subnodes whose user belongs to ANY of these
                                           # groups (e.g. 27 = `sudo` on Debian/Ubuntu). Membership
                                           # is resolved via the full OS group list (primary +
                                           # supplementary), not just the user's primary GID.
                                           # GID 0 (root) and the hub's own GID are always
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
sudo constellation hub install \
  --config-file /etc/constellation/hub.yaml \
  --user constellation \
  --unit-name constellation-hub
```

This prints the unit to stdout followed by install instructions. Follow the printed steps to install and enable the service.

Options:
- `--config-file` — path to config file (default: `/etc/constellation/hub.yaml`, or `$CONSTELLATION_HUB_CONFIG`)
- `--user` — service user (default: `constellation`); must have `CAP_SETUID`/`CAP_SETGID`
- `--unit-name` — systemd unit name (default: `constellation-hub`)

The generated unit sets `AmbientCapabilities=CAP_SETUID CAP_SETGID`, `CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, `NoNewPrivileges=no`, `ProtectSystem=strict`, and `ReadWritePaths=/var/log/constellation`.

### Start / stop

```sh
# Start (direct, non-systemd)
constellation hub start --config-file /etc/constellation/hub.yaml

# Via systemd
sudo systemctl start constellation-hub
sudo systemctl stop constellation-hub

# Stop shortcut (calls systemctl stop)
constellation hub stop --unit-name constellation-hub
```

`--config-file` defaults to `/etc/constellation/hub.yaml`, overridable via `CONSTELLATION_HUB_CONFIG` or the flag itself — all `hub` subcommands resolve it the same way.

---

## 6. Operator Runbook

### Validate config before starting

```sh
constellation hub validate-config --config-file /etc/constellation/hub.yaml
```

Checks: required fields are present; label paths exist on disk; `user_map` usernames resolve locally; UID range bounds are consistent; token is available (env or env_file).

### Show running config summary

```sh
constellation hub status --config-file /etc/constellation/hub.yaml
constellation hub status --config-file /etc/constellation/hub.yaml --json
```

### Apply a config change

Config changes require a full restart — there is no live reload:

```sh
sudo systemctl restart constellation-hub
```

### Rotate the service token

```sh
constellation hub rotate-token --config-file /etc/constellation/hub.yaml
sudo systemctl restart constellation-hub
```

The command connects to the relay via WebSocket, requests a new token, and writes it to `env_file`. The hub must be restarted to reconnect with the new token.

### Revoke a hub

```sh
# Get the executor ID from the relay:
constellation relay executors list --json

# Revoke:
constellation relay executors revoke <executor-id>
```

The hub goes offline immediately. To re-register, run `constellation hub register` again (requires admin approval).

### Audit log

Each tool call produces one JSONL entry:

```json
{
  "ts": "2026-06-06T12:00:00.000Z",
  "hub_name": "nas-shared",
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

Rotate logs with `logrotate`. The hub does not rotate logs itself.

### Inspect shared labels (admin)

View the full shared label registry including permission configs:

```sh
constellation relay shared-labels list
constellation relay shared-labels list --executor <executor-id>
constellation relay shared-labels list --json
```

Requires an elevated admin session (`constellation relay elevate`).
