# Hub

A hub is a Constellation deployment for machines shared by multiple users (NAS, dev server, domain-joined host). Unlike a node — which runs under the user's own OS identity and manages its own shares — the hub runs as a dedicated service user and dispatches each tool call under the requesting user's OS identity.

See [Architecture → Hub](architecture.md#hub) for how the hub fits into the relay/node/hub system as a whole; this document covers its design, security model, and operation in full detail.

- [1. Architecture and Design Assumptions](#1-architecture-and-design-assumptions)
- [2. Security Model](#2-security-model)
- [3. Request Flow](#3-request-flow)
- [4. Permission Model](#4-permission-model)
- [5. Deployment](#5-deployment)
- [6. Operator Runbook](#6-operator-runbook)

---

## 1. Architecture and Design Assumptions

The hub model rests on two assumptions:

1. **The relay is a trusted intermediary.** Identity claims forwarded in the RPC envelope arrive from the relay, which authenticated the user via OIDC. The hub trusts these claims as authoritative — the same trust model as SSSD or an LDAP client trusting a directory server.

2. **The admin, not users, controls what is shared.** Shares (path mounts) are defined in the hub config by the operator. Users cannot register, modify, or remove shares. The hub connects to the relay with a service-level token that is not bound to any user.

**Node vs. hub:**

| | Node | Hub |
|---|---|---|
| Runs as | The user's own OS identity | A dedicated low-privilege service user |
| Share registry | User-managed (via relay sync) | Admin-defined in config file |
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
- **Subnode workers never inherit the parent's environment.** `CONSTELLATION_HUB_TOKEN` (and anything else read from `env_file`) lives in the hub's `process.env`, but each tool call is dispatched to a forked worker that immediately `setuid()`s to the requesting user — a possibly low-trust local account that could read its own `/proc/<pid>/environ`. Spreading `process.env` into that fork would hand the hub token (and any other secret) to that user. Instead, `buildWorkerEnv()` in `packages/hub/src/subnode.ts` constructs an explicit allowlisted environment (`CONSTELLATION_TARGET_*`, `HOME`/`USER`/`LOGNAME` for the *target* user, `PATH`, `LOG_LEVEL`). **If you find a variable isn't propagating to the subnode worker, this is why — add it explicitly to `buildWorkerEnv`, do not change it back to `...process.env`.** See [ADR 0014](adr/0014-subnode-worker-explicit-env.md).

### Sub-path access control

The hub controls access at the share root level only. Access to specific files and directories within a share is enforced entirely by the OS filesystem permissions of the subnode running under the user's identity. Operators who need sub-path restrictions should use standard OS permissions (`chmod`, ACLs, supplementary groups) on the underlying paths.

### UID restrictions

The hub refuses to spawn subnodes as:
- UID 0 (root) — always blocked, not configurable
- The hub's own UID — always blocked
- UIDs outside `subnode_uid.allowed_range` (if configured)
- UIDs within `subnode_uid.blocked_range` (if configured)
- UIDs in `subnode_uid.blocked_uids` (if configured)

See the config reference in [§5](#5-deployment) for details.

### GID restrictions

UID checks gate on a single value, but a subnode's *effective* privileges
depend on its **entire group membership** — primary group plus every
supplementary group the OS resolves for that account via `initgroups()` at
privilege-drop time (see `subnode-worker.ts`). A user with an unremarkable
primary GID could still be a secondary member of `docker`, `sudo`, or any
group that owns files outside the shares you've configured — none of which the
UID allow/block lists would ever see.

Because group membership is multi-valued, there's no equivalent of
`allowed_range` / a single "blocked GID" that can be trimmed away — the hub
either spawns the subnode with the user's full, OS-resolved group list (the
only option `initgroups()` supports; see [ADR 0014](adr/0014-subnode-worker-explicit-env.md)) or it doesn't spawn at all.
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

See the config reference in [§5](#5-deployment) for details.

---

## 3. Request Flow

```
MCP client
  → POST /mcp (Bearer token)
    → Relay authenticates session → retrieves userId, oidcSub, lastKnownClaims
    → Relay resolves share → checks HubShare registry (optimistic permission check)
    → Relay builds RPC envelope: { tool, share, absolute_root, user_oidc_sub, user_claims, params }
    → Relay forwards RPC via WebSocket to hub
      → Hub resolves OS identity (3-tier chain)
      → Hub checks permissions (share-level access against admin config)
      → Hub looks up or spawns subnode for resolved user
        → Subnode runs under user's OS identity (uid + full supplementary groups via initgroups)
        → Subnode executes tool via FileExecutor
        → Subnode sends SubnodeResponse to parent
      → Hub writes audit log entry
      → Hub sends RPC response to relay
    → Relay returns result to MCP client
```

Two enforcement points:
- **Relay (optimistic):** evaluates the synced permission blob (`default` access and per-`oidc_sub` overrides) at share resolution time. May grant access that the hub subsequently denies (e.g. due to Tier 1 identity resolution failure).
- **Hub (authoritative):** full identity resolution and permission check. Result at the hub always takes precedence.

### Subnode worker pool

Each resolved user gets a logical **subnode** — a per-user container that owns
1..N worker processes. Workers are forked on demand and reused across requests.

**Tiers.** Workers are split into two tiers, fixed at spawn time:

| Tier | Count | Idle timeout config |
|---|---|---|
| **Warm** | First `min` workers per user | `warm_idle_seconds` (default 300 s) |
| **Burst** | Workers beyond `min`, up to `max` | `burst_idle_seconds` (default 30 s) |

By default `min=1, max=1` — one warm worker per active user, same concurrency
as before. Admins opt into burst concurrency by raising `max`.

**Idle timeout floor.** Both `warm_idle_seconds` and `burst_idle_seconds` are
hard-floored at 30 seconds (configurable floor constant `MIN_WORKER_IDLE_SECONDS`
in `config.ts`). There is no "terminate immediately after every request" mode —
the minimum is a 30 s idle window.

**Dispatch and queueing.** When a request arrives for a user:

1. If an idle worker exists, it receives the request immediately.
2. If no idle worker exists but `workers.length < max`, a new worker is spawned
   (warm tier if `workers.length < min`, burst otherwise).
3. If all workers are busy and `workers.length === max`, the request is queued.
   Queued requests wait up to `queue_timeout` (see config reference); if no
   worker frees up in time, the request is rejected with a timeout error.

The assignment decision (steps 1–3) is serialized per user via a promise lock
so concurrent dispatches cannot race to double-spawn.

**Subnode lifecycle.** Once a user's last worker is removed (idle timeout, RPC
timeout, crash), the subnode is deleted. The next request from that user creates
a fresh subnode.

**Global subnode cap.** `subnode_workers.max` bounds workers *per user* — it
does not limit how many distinct users can have a subnode at once. On a
directory-backed hub (LDAP/AD), every distinct account that connects gets its
own subnode, so a deployment with many users has no built-in ceiling on total
worker processes unless `max_concurrent_subnodes` is set. When the cap is hit,
a request from a *new* user is rejected with a capacity error; requests from
users who already have a subnode are unaffected. Defaults to `0` (unlimited) —
the per-user cap and idle eviction above already bound steady-state growth, so
this is an opt-in extra ceiling, not a mandatory one.

---

## 4. Permission Model

Permissions are defined per-share in the config. The evaluation order:

1. If the share is not in the admin config → reject.
2. If `permissions.overrides` contains an entry for the user's `oidc_sub` → use that access level.
3. Otherwise use `permissions.default`.

Access levels:
- `read-only` — permits read, search, and listing tools; blocks write tools (`write_file`, `edit_file`, `create_directory`, `delete`, `move`, `copy`).
- `read-write` — permits all tools.
- `none` — rejects all access; share is hidden in discovery.

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
  --relay https://relay.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/hub.env
```

The browser opens automatically for admin approval. The token is written to the env file — the operator never sees the raw token.

Options:
- `--relay` — required (or set `RELAY_URL`)
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

shares:
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
subnode_rpc_timeout_seconds: 30            # Timeout per in-flight tool call IPC round-trip (default: 30)
max_concurrent_subnodes: 0                 # Global cap on distinct users with a subnode at once.
                                           # 0 = unlimited (default). Independent of subnode_workers.max,
                                           # which only caps workers per user — see "Global subnode cap" above.

subnode_workers:
  min: 1                                   # Always-warm workers per user (floor: 1; default: 1)
  max: 1                                   # Total worker cap per user (floor: min; default: min)
  warm_idle_seconds: 300                   # Idle timeout for the first `min` workers (floor: 30; default: 300)
  burst_idle_seconds: 30                   # Idle timeout for workers beyond `min` (floor: 30; default: 30)
  queue_timeout: 0.5                       # How long a request waits for a free worker when all are busy
                                           # and workers.length == max.
                                           #
                                           # Float: fraction of subnode_rpc_timeout_seconds (e.g. 0.5 = half).
                                           # Integer: explicit seconds, clamped to subnode_rpc_timeout_seconds.
                                           # Note: in YAML, 1.0 parses as integer 1 (1 s). Fractions outside
                                           # [0.3, 0.8] are not recommended (hub logs a startup warning, does
                                           # not fail validation): below 0.3, queued requests tend to time out
                                           # before a worker frees up; above 0.8, a request that does get a
                                           # worker has too little of the RPC budget left to finish before
                                           # subnode_rpc_timeout_seconds elapses.
                                           # Default: 0.5

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

shares:
  - name: projects
    path: /srv/projects
    instructions: "Optional text surfaced to MCP clients via list_shares"
                                           # Hard cap: 500 chars (longer values are dropped with a
                                           # warning). Recommended: keep under 250 — this should give
                                           # light context/framing for the share, not document it or
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

`instructions`/`context_file` share the same 500-char hard cap, 250-char recommendation, and fallback behavior as a node's `paths.yaml` — see [Configuration → `paths.yaml`](configuration.md#pathsyaml) for the full explanation.

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

Checks: required fields are present; share paths exist on disk; `user_map` usernames resolve locally; UID range bounds are consistent; token is available (env or env_file).

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
```

If the hub is currently running, this asks the live daemon to rotate on its own connection — it persists the new token to `env_file` and reconnects immediately. **No restart needed**, and no service interruption: the daemon never drops its connection to the relay.

If no hub is running (or it's unreachable), the command falls back to requesting a new token directly and writing it to `env_file`; in that case, start (or restart) the hub to connect with it:

```sh
sudo systemctl restart constellation-hub
```

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
  "share": "projects",
  "tool": "read_file",
  "outcome": "ok",
  "error": null
}
```

`outcome` values: `ok` | `identity_error` | `permission_denied` | `exec_error`.

Rotate logs with `logrotate`. The hub does not rotate logs itself.

### Inspect hub shares (admin)

View the full hub share registry including permission configs:

```sh
constellation relay hub-shares list
constellation relay hub-shares list --executor <executor-id>
constellation relay hub-shares list --json
```

Requires an elevated admin session (`constellation relay elevate`).
