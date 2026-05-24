# Agent Reference

The agent is a long-running process that connects outbound to the broker over WebSocket and executes file operations locally. It is the **security boundary** — it enforces path restrictions regardless of what the broker forwards.

---

## Architecture

```
broker (VPS)
    │  wss://<broker>/agent/connect
    │  Bearer <agent-token>
    ▼
AgentConnection (reconnects automatically)
    │
    ├── on connect → send config_update (path labels)
    ├── on RPC → validate root → validate path → dispatch to ops
    └── on token_rotated → persist token → close (triggers reconnect)
```

The agent never opens inbound ports. All traffic is outbound.

---

## Configuration Files

Config files live in the platform-default directory unless overridden:

| Platform | Default path |
|---|---|
| Linux / macOS | `~/.config/constellation/` |
| Windows | `%APPDATA%\constellation\` |

Override with `--config <dir>` or `CONSTELLATION_CONFIG_DIR=<dir>`.

Set restrictive permissions on both files:
```sh
chmod 600 ~/.config/constellation/agent.yaml
chmod 600 ~/.config/constellation/paths.yaml
```

### `agent.yaml`

Created by `constellation agent init`. Do not edit `agent_token` by hand.

```yaml
broker_url: https://your-broker.example.com
agent_token: <secret>
host: home-server
max_file_size_kb: 100
```

| Field | Description |
|---|---|
| `broker_url` | Full HTTPS URL of the broker, no trailing slash |
| `agent_token` | Bearer token used to authenticate the WebSocket connection |
| `host` | Display name for this machine, set during `agent init` |
| `max_file_size_kb` | Maximum file size for a full `read_file` call (default: `100`). Range reads (`start_line`/`end_line`) are not subject to this cap. |

### `paths.yaml`

Edited manually or via `constellation agent paths add/remove`. Changes take effect on the next `constellation agent sync` or agent restart.

```yaml
paths:
  - label: projects
    path: /home/user/projects
  - label: dotfiles
    path: /home/user/.config
```

Labels must be unique across all agents on your account. The path must be an absolute path that exists on this machine.

### `broker-session.yaml`

Created by `constellation broker login`. Stores the management API session used by `constellation broker *` commands. Not used by the agent daemon itself.

```yaml
broker_url: https://your-broker.example.com
access_token: <secret>
access_token_expires_at: "2026-05-22T10:00:00.000Z"
refresh_token: <secret>
refresh_token_expires_at: "2026-06-21T10:00:00.000Z"
```

The CLI silently refreshes the access token using the refresh token when it expires. If the refresh token also expires, re-run `constellation broker login`.

---

## Connection Behaviour

On start, the agent connects to `wss://<broker_url>/agent/connect` with `Authorization: Bearer <agent_token>`.

**On successful connect:** sends a `config_update` message immediately to push the current `paths.yaml` to the broker.

**Reconnect backoff:** starts at 1 second, doubles on each failure up to a maximum of 60 seconds, with ±20% jitter. Reconnects indefinitely until stopped.

**Token rotation:** when the broker sends `token_rotated`, the agent writes the new token to `agent.yaml` and closes the WebSocket. The reconnect loop picks up the new token automatically from disk on the next connect attempt.

---

## Security Model

The agent is the sole enforcement point for filesystem access. Two layers of validation run before every operation:

**1. Root allowlist check**

The broker resolves a label to an `absolute_root` and includes it in the RPC envelope. The agent looks up that path in the local `paths.yaml`. If it doesn't match exactly, the request is rejected with `"Path rejected by agent"` — the broker cannot fabricate a root the agent doesn't know about.

**2. Traversal and symlink check**

For every path field in the RPC envelope — `relative_path`, `src_relative_path`, `dst_relative_path` — the agent resolves the final path via `fs.realpath` (follows symlinks, canonicalises `..`). If the resolved path doesn't have the resolved root as a prefix, the request is rejected. This prevents both `../` traversal and symlink escapes that point outside the label root.

For cross-label copy/move operations the broker also supplies `dst_root` (the destination label's absolute path). The agent validates `dst_root` against the local `paths.yaml` allowlist and uses it as the boundary for the `dst_relative_path` check.

For write targets that don't exist yet, the nearest existing parent is resolved and the suffix is reconstructed — so new files can be created within the root without bypassing the check.

---

## Tool Caps and Limits

Enforced by the agent, independent of broker settings:

| Tool | Limit |
|---|---|
| `list_directory` | Default 2,000 nodes per call; hard cap 10,000. Set `limit` to override (capped at 10,000). Returns `truncated: true` and `truncated_by` when hit. |
| `find_files` | 200 results; returns `truncated: true` when hit. |
| `grep_files` | 50 total matches or 100 KB of output, whichever comes first; returns `truncated: true`. Individual files larger than 10 MB are skipped silently. |
| `read_file` | `max_file_size_kb` from `agent.yaml` (default 100 KB). Applies to both full reads and range reads — each call returns at most that many KB. Use `start_line`/`end_line` to page through a large file across multiple calls. `total_lines` in the response tells you the file's full line count so you know when to stop. |
| `copy` / `move` | Fails if the destination already exists. Cross-device `move` falls back to copy + delete automatically. |
| `delete` (directory) | Without `recursive: true`, returns a summary (`size_bytes`, `file_count`) and `requires_confirmation: true` instead of deleting. Re-call with `recursive: true` to proceed. |

---

## Agent CLI Reference

```sh
constellation [--config <dir>] <command>
```

`--config <dir>` and `CONSTELLATION_CONFIG_DIR` both override the default config directory.

### `agent init`

```sh
constellation agent init --broker <url>
```

Runs the device code OAuth flow: opens a browser, authenticates via the OIDC provider, creates an agent registration on the broker, and writes `agent.yaml` and an empty `paths.yaml`. Safe to re-run — rewrites credentials without touching existing path config.

### `agent install`

```sh
constellation agent install
```

Registers the agent with the OS service manager for user-scoped autostart. Does not require root/admin. Writes a unit file or plist to the user's service directory and enables it.

| Platform | Mechanism | Unit location |
|---|---|---|
| Linux | systemd user unit | `~/.config/systemd/user/constellation-agent.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.constellation.agent.plist` |
| Windows | Task Scheduler | Task named `constellation-agent` |

### `agent start` / `stop` / `restart`

Start, stop, and restart the service via the OS service manager. `start --foreground` runs the daemon directly in the current process (used internally by the service unit).

### `agent status [--json]`

Shows service state (active/inactive/unknown), broker URL, host name, and configured labels. `--json` emits a machine-readable object.

### `agent sync`

Opens a one-shot WebSocket connection to the broker, sends a `config_update` with the current `paths.yaml`, waits for acknowledgement, then exits. Only needed when `paths.yaml` has been edited manually — `agent paths add` and `agent paths remove` sync automatically.

### `agent rotate`

Requests a token rotation from the broker via a one-shot WebSocket connection. The new token is written to `agent.yaml`. Restart the agent service afterwards to reconnect with the new token.

### `agent rename <host>`

Pushes a new host name to the broker and updates `agent.yaml`. Fails if another agent on the same account already uses that name.

### `agent logs [-f] [--lines <n>]`

Tails or displays agent service logs. Defaults to 50 lines.

| Platform | Log source |
|---|---|
| Linux | `journalctl --user -u constellation-agent` |
| macOS | `~/Library/Logs/constellation-agent.log` |
| Windows | Not supported — check Event Viewer |

### `agent config show`

Prints `agent.yaml` and `paths.yaml` to stdout. The `agent_token` value is masked.

### `agent config edit`

Opens `agent.yaml` and `paths.yaml` in `$EDITOR` (falls back to `vi`).

### `agent config path`

Prints the resolved config directory path. Useful for scripting.

### `agent paths list [--json]`

Lists labels and paths from `paths.yaml`.

### `agent paths add <label> <path>`

Appends an entry to `paths.yaml` and syncs to the broker immediately.

### `agent paths remove <label>`

Removes an entry from `paths.yaml` and syncs to the broker immediately.

---

## Broker CLI Reference

These commands manage the broker remotely via the management API. They require `constellation broker login` to have been run first. The session is stored in `broker-session.yaml` and refreshed silently as needed.

### `broker login [--broker <url>]`

Runs the device code OAuth flow for `broker:manage` scope. Opens a browser. Writes session to `broker-session.yaml`. Broker URL defaults to the one in `agent.yaml` if not specified.

### `broker logout`

Deletes `broker-session.yaml`. Does not revoke the token on the broker.

### `broker status`

Shows broker health, uptime, and version.

### `broker agents list [--json]`

Lists all agents registered to your account with their online status and labels.

### `broker agents revoke <agent-id>`

Revokes the agent's token. The agent goes offline immediately and cannot reconnect until re-initialized. Prompts for confirmation.

### `broker labels list [--agent <id>] [--json]`

Lists path labels across all agents, optionally filtered to a specific agent ID.

### `broker filters list [--json]`

Lists active broker-side path deny filters.

### `broker filters add <pattern> [--type glob|regex] [--agent <id>]`

Adds a deny filter. `--type` defaults to `glob`. `--agent` scopes it to a specific agent; omit to apply to all agents.

### `broker filters remove <filter-id>`

Removes a deny filter by ID.

### `broker sessions list [--json]`

Lists active MCP client OAuth sessions (non-expired only).

### `broker sessions revoke <session-id>`

Immediately invalidates an MCP client session (both access and refresh tokens).

### `broker account deactivate`

Deactivates your account after an interactive confirmation prompt. All agent connections and MCP client sessions are immediately blocked. Re-running `constellation agent init` is required to restore access.
