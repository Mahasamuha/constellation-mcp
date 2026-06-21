# Constellation Reference

- [Node CLI](#node-cli)
- [Hub CLI](#hub-cli)
- [Node GUI](#node-gui)
- [Relay CLI](#relay-cli)
- [MCP Tools](#mcp-tools)
- [Management API](#management-api)

---

## Node CLI

```sh
constellation node [--config-dir <dir>] <command>
```

`--config-dir <dir>` (an option on the `node` subcommand, e.g. `constellation node --config-dir /path config show`) and `CONSTELLATION_CONFIG_DIR` both override the default config directory (`~/.config/constellation/` on Linux/macOS, `%APPDATA%\constellation\` on Windows).

### `node init`

```sh
constellation node init --relay <url>
```

Runs the device code OAuth flow, creates a node registration on the relay, and writes `node.yaml` and an empty `paths.yaml`. Safe to re-run — rewrites credentials without touching existing path config.

### `node install`

```sh
constellation node install
```

Registers the node with the OS service manager for user-scoped autostart. Does not require root/admin.

| Platform | Mechanism | Location |
|---|---|---|
| Linux | systemd user unit | `~/.config/systemd/user/constellation-node.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.constellation.node.plist` |
| Windows | Task Scheduler | Task named `constellation-node` |

### `node start` / `stop` / `restart`

Start, stop, and restart the node service. `start --foreground` runs the daemon directly in the current process.

### `node status [--json]`

Shows service state (active/inactive/unknown), relay URL, host name, and configured shares. `--json` emits a machine-readable object.

### `node sync`

Opens a one-shot WebSocket connection, pushes the current `paths.yaml` to the relay, and exits. Only needed after manually editing `paths.yaml` — `node paths add` and `node paths remove` sync automatically.

### `node rotate`

Requests a token rotation from the relay. The new token is written to `node.yaml`. Restart the node service afterwards to reconnect with the new token.

### `node rename <host>`

Pushes a new host name to the relay and updates `node.yaml`. Fails if another node on the same account already uses that name.

### `node logs [-f] [--lines <n>]`

Displays node service logs. Defaults to 50 lines. `-f` follows the log stream.

| Platform | Log source |
|---|---|
| Linux | `journalctl --user -u constellation-node` |
| macOS | `~/Library/Logs/constellation-node.log` |
| Windows | Not supported — check Event Viewer |

### `node config show`

Prints `node.yaml` and `paths.yaml` to stdout. The `node_token` value is masked.

### `node config edit`

Opens `node.yaml` and `paths.yaml` in `$EDITOR` (falls back to `vi`).

### `node config path`

Prints the resolved config directory path.

### `node paths list [--json]`

Lists shares and paths from `paths.yaml`.

### `node paths add <share> <path> [--instructions <text>]`

Appends an entry to `paths.yaml` and syncs to the relay immediately. `--instructions` sets inline text (max 500 characters) surfaced to MCP clients via `list_shares`; see [`paths.yaml`](configuration.md#pathsyaml) for the relationship with `context_file`.

### `node paths remove <share>`

Removes an entry from `paths.yaml` and syncs to the relay immediately.

---

## Hub CLI

The hub is a system-level daemon that serves files to multiple users from a single process. It reads from a YAML config file and authenticates via `CONSTELLATION_HUB_TOKEN` in the environment (typically sourced from an env file).

Every subcommand below that takes `--config-file <path>` resolves it the same way: the flag, then `$CONSTELLATION_HUB_CONFIG`, then `/etc/constellation/hub.yaml` — so `--config-file` can be omitted when using the conventional path.

### `hub register`

```sh
constellation hub register --relay <url> [--host-name <name>] [--env-file <path>]
```

Starts a device code OAuth flow that requires admin approval. Once approved, writes the service token to the env file (default `/etc/constellation/hub.env`, mode 0600). The token is never printed to the terminal.

| Flag | Default | Description |
|---|---|---|
| `--relay` | `$RELAY_URL` | Relay URL (required) |
| `--host-name` | system hostname | Name for this hub on the relay |
| `--env-file` | `/etc/constellation/hub.env` | Path to write `CONSTELLATION_HUB_TOKEN` |

### `hub validate-config`

```sh
constellation hub validate-config [--config-file <path>]
```

Dry-run validation of a hub config file. Checks schema, share path existence, `context_file` readability (when set without an inline `instructions` override), `user_map` username resolution, and token availability. Exits non-zero on error.

### `hub start`

```sh
constellation hub start [--config-file <path>]
```

Starts the hub daemon.

### `hub status [--json] [--config-file <path>]`

```sh
constellation hub status [--config-file <path>]
```

Prints hub name, relay URL, and share list from the config file.

### `hub install`

```sh
constellation hub install [--config-file <path>] [--unit-name <name>] [--user <user>]
```

Prints a systemd system unit file to stdout. Redirect it to `/etc/systemd/system/<unit-name>.service` and run `systemctl daemon-reload && systemctl enable --now <unit-name>`.

| Flag | Default | Description |
|---|---|---|
| `--unit-name` | `constellation-hub` | Systemd unit name |
| `--user` | `constellation` | Service user (must have `CAP_SETUID`/`CAP_SETGID`) |

### `hub stop`

```sh
constellation hub stop [--unit-name <name>]
```

Stops the systemd unit (calls `systemctl stop`). If the hub is not managed by systemd, send `SIGTERM` to the process manually.

### `hub rotate-token`

```sh
constellation hub rotate-token [--config-file <path>]
```

Rotates the hub token via a WebSocket connection and writes the new token to the `env_file` specified in the config. Restart the hub afterwards to reconnect.

---

## Node GUI

The node GUI is a system tray application for desktop machines. Every action it exposes is a wrapper around the corresponding `constellation node` CLI command — there is no functionality available in the GUI that cannot be performed from the CLI.

Download: [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest). The CLI must also be installed and available on `PATH`.

### Tray menu

The tray icon reflects connection state (blue = connected, yellow = connecting, grey = stopped/unconfigured, red = unexpectedly disconnected). The menu adapts based on whether the node is configured.

**Configured:**
- **Status & Logs** — open the Status window
- **Paths** — open the Paths window
- **Settings** — open the Settings window
- **Start / Stop / Restart** — run `constellation node start/stop/restart`
- **Quit**

**Unconfigured** (no `node.yaml` or missing credentials):
- **Connect to Relay** — open the Auth window
- **Quit**

### Auth window

Runs the device code OAuth flow (`constellation node init`). Enter the relay URL, then approve the login in your browser. On success, writes `node.yaml` and creates `paths.yaml` if absent.

### Status window

Shows live node state polled every 5 seconds: connection status, relay URL, last heartbeat, host name, token dates, service state, and the last 50 lines of service logs. **Start / Stop / Restart** buttons run the corresponding CLI commands.

### Paths window

Displays entries from `paths.yaml` in a table. Adding a path calls `constellation node paths add`; removing one calls `constellation node paths remove`. Both sync to the relay immediately. A native folder picker is available when adding a path.

### Settings window

Edits `node.yaml` fields:

| Field | Action |
|---|---|
| Relay URL | Written directly to `node.yaml`; requires a node restart to take effect |
| Node name (host) | Calls `constellation node rename` on save |
| Max file size (KB) | Written directly to `node.yaml`; range 1–100 |
| Config directory | Read-only display |

**Danger zone** (collapsed by default):
- **Rotate token** — calls `constellation node rotate`; fires an OS notification on success
- **Deregister node** — prompts for confirmation, deletes `node.yaml`, resets to unconfigured state

---

## Relay CLI

These commands manage the relay remotely via the management API. Requires `constellation relay login` first. The session in `relay-session.yaml` is refreshed silently as needed.

`--config-dir <dir>` (e.g. `constellation relay --config-dir /path login`) and `CONSTELLATION_CONFIG_DIR` override the default config directory where `relay-session.yaml` is read and written.

`--relay <url>` is declared on the `relay` command itself, not on `login`, `elevate`, `user promote`, or `user demote` individually — it must appear somewhere after `relay` on the command line. The recommended, always-safe position is right after `relay` and before the subcommand (e.g. `constellation relay --relay <url> login`).

### `relay login`

```sh
constellation relay --relay <url> login
```

Runs the device code OAuth flow for `relay:manage` scope. Writes session to `relay-session.yaml`. Relay URL defaults to the one in `node.yaml` if not specified.

### `relay logout`

Deletes `relay-session.yaml`. Does not revoke the token on the relay.

### `relay status`

Shows relay health, uptime, and version.

### `relay executors list [--json]`

Lists all executors registered to your account with their online status and shares.

### `relay executors revoke <executor-id>`

Revokes the executor's token. The executor goes offline immediately and cannot reconnect until re-initialized. Prompts for confirmation.

### `relay shares list [--executor <id>] [--json]`

Lists path shares across all executors, optionally filtered to a specific executor ID.

### `relay filters list [--json]`

Lists active relay-side path deny filters.

### `relay filters add <pattern> [--type glob|regex] [--executor <id>]`

Adds a deny filter. `--type` defaults to `glob`. `--executor` scopes it to a specific executor; omit to apply to all executors.

### `relay filters remove <filter-id>`

Removes a deny filter by ID.

### `relay sessions list [--json]`

Lists active MCP client OAuth sessions (non-expired only).

### `relay sessions revoke <session-id>`

Immediately invalidates an MCP client session (both access and refresh tokens).

### `relay users list [--json]`

Lists all local user accounts. Only available when the relay is running in `AUTH_MODE=local`.

### `relay users add <username>`

Creates a new local user. Prompts for a password (minimum 12 characters).

### `relay users remove <username>`

Deactivates a local user (soft delete). Prompts for confirmation. Access is cut immediately — every existing session and executor connection for that user is rejected on its very next request, not just future logins.

### `relay users reset-password <username>`

Sets a new password for a local user and immediately invalidates all of their existing OAuth sessions. Prompts for the new password (minimum 12 characters).

### `relay account deactivate`

Deactivates your account after an interactive confirmation prompt. All executor connections and MCP client sessions are immediately blocked. There is no CLI command to restore a deactivated account — reactivation requires a database-level change.

### `relay elevate`

```sh
constellation relay --relay <url> elevate
```

Requests temporary admin access via a browser-approved device code flow (step-up authentication). Opens the approval URL automatically. On success, the current `relay:manage` session is elevated and subsequent admin-required commands succeed. Admin approval is required; the request is denied if the account does not have admin privileges.

### `relay user promote <identifier>`

```sh
constellation relay --relay <url> user promote <identifier> [--admin-token <token>]
```

Grants admin role to a user. `<identifier>` is the OIDC sub or (in `AUTH_MODE=local`) the username. Requires `RELAY_ADMIN_TOKEN` env var or `--admin-token` flag — this is a bootstrap operation not gated by OAuth.

### `relay user demote <identifier>`

```sh
constellation relay --relay <url> user demote <identifier> [--admin-token <token>]
```

Revokes admin role from a user. Same auth requirements as `relay user promote`.

### `relay hub-shares list [--executor <id>] [--json]`

Lists all hub shares synced to the relay. Requires an elevated admin session (`relay elevate` first). `--executor` filters to a specific hub by ID.

### `relay token create --shared`

```sh
constellation relay token create --shared
```

Break-glass operation: creates a hub service token without going through the device code flow. Use only when `constellation hub register` is unavailable (e.g. scripted provisioning). Requires an elevated admin session. The token is shown once — store it immediately. Displays a prominent warning before proceeding.

---

## MCP Tools

Tools are called by MCP clients (Claude, ChatGPT, Cursor) after authenticating via OAuth. Every tool that operates on files takes a `share` (a named path root registered by a node) and optionally a `host` to disambiguate when the same share name exists on multiple machines.

### Node-enforced caps

These limits are applied by the node regardless of relay settings.

| Tool | Limit |
|---|---|
| `list_directory` | Default 2,000 nodes per call; hard cap 10,000. Set `limit` to override (capped at 10,000). Returns `truncated: true` and `truncated_by` when the limit is hit. |
| `find_files` | 200 results. Returns `truncated: true` when hit. |
| `grep_files` | 50 total matches or 100 KB of output, whichever comes first. Files larger than 10 MB are skipped silently. Returns `truncated: true` when hit. |
| `read_file` | `max_file_size_kb` from `node.yaml` (default 100 KB) per call. Applies to both full reads and range reads. Use `start_line`/`end_line` to page through large files; `total_lines` in the response tells you when to stop. |
| `copy` / `move` | Fails if the destination already exists. Cross-device `move` falls back to copy + delete automatically. |
| `delete` (directory) | Without `recursive: true`, returns a dry-run summary (`size_bytes`, `file_count`, `requires_confirmation: true`). Re-call with `recursive: true` to proceed. |

---

### `list_hosts`

List all registered hosts with online status and their shares.

**Input**: none

**Output**:

| Field | Type |
|---|---|
| `hosts` | `{ host, online, last_seen, shares }[]` |

---

### `list_shares`

List path shares, optionally filtered by host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `host` | string? | Filter to a specific host |

**Output**: `{ shares: { share, host, instructions, modality, access }[] }`

`instructions` is the share's configured inline text or `context_file` contents (or `null` if neither is set, the cap was exceeded, or the file couldn't be read). Capped at 500 characters — see [`paths.yaml`](configuration.md#pathsyaml).

---

### `list_directory`

Enumerate directory contents — names and types. Use `recursive: true` with `exclude: ["node_modules", ".git"]` for repo trees.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string? | Subdirectory within the share root (defaults to root) |
| `recursive` | boolean? | Recurse into subdirectories |
| `max_depth` | integer? | Maximum recursion depth |
| `limit` | integer? | Max nodes returned; default 2,000, hard cap 10,000 |
| `exclude` | string[]? | Directory names to skip during recursion |
| `host` | string? | Disambiguate when multiple hosts use the same share name |

**Output**: `{ nodes: { path, type }[], total_nodes, truncated, truncated_by? }`

`truncated_by` is `"limit"` or `"max_depth"`.

---

### `file_info`

Return metadata for a single path without reading its contents.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Path to the file or directory |
| `host` | string? | |

**Output**: `{ size, mtime, type, target? }`

`target` is present when `type` is `"symlink"`.

---

### `find_files`

Find files by name using glob or regex. Matches filenames and paths only — does not search file contents. Capped at 200 results.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `pattern` | string | Glob (micromatch) or regex pattern |
| `relative_path` | string? | Subdirectory to search within |
| `type` | `"glob"` \| `"regex"` | Default: `"glob"` |
| `host` | string? | |

**Output**: `{ matches: string[], truncated }`

---

### `read_file`

Read a file's content, optionally restricted to a line range. Returns `total_lines` so you can page through large files across multiple calls.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Path to the file |
| `start_line` | integer? | First line to return (1-based) |
| `end_line` | integer? | Last line to return (inclusive) |
| `host` | string? | |

**Output**: `{ content, total_lines }`

Files exceeding `max_file_size_kb` (node config, default 100 KB) return `FILE_TOO_LARGE`. Range reads that exceed the cap return `READ_TOO_LARGE` — narrow the range.

---

### `grep_files`

Search file contents for a literal string or regex. Does not match filenames. Results are grouped by file, capped at 50 matches or 100 KB of output, whichever comes first. Files larger than 10 MB are skipped.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `pattern` | string | Literal string or regex pattern |
| `relative_path` | string? | File or directory to search within |
| `file_glob` | string? | Glob to filter files when searching a directory (e.g. `"*.ts"`) |
| `type` | `"literal"` \| `"regex"` | Default: `"literal"` |
| `host` | string? | |

**Output**: `{ results: { file, matches: { line, text }[] }[], truncated }`

---

### `write_file`

Write content to a file. Replaces the entire file by default.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Path to the file |
| `content` | string | Content to write |
| `mode` | `"overwrite"` \| `"append"` | Default: `"overwrite"` |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `edit_file`

Apply a list of exact-match text substitutions to an existing file. Each `old_text` must match exactly once — zero or multiple matches abort with `EDIT_NO_MATCH` or `EDIT_AMBIGUOUS` (includes `edit_index` and `match_count`). All edits are validated before any write.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Path to the file |
| `edits` | `{ old_text, new_text }[]` | List of substitutions to apply |
| `dry_run` | boolean? | Return the diff without writing |
| `host` | string? | |

**Output**: `{ diff }` — unified diff of the applied changes.

---

### `copy`

Copy a file or directory. Fails if the destination already exists. `dst_share` enables cross-share copy on the same host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Source share |
| `src_relative_path` | string | Source path within the share |
| `dst_relative_path` | string | Destination path |
| `dst_share` | string? | Destination share for cross-share copy |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `move`

Move a file or directory. Removes the source after copying. Fails if the destination already exists. `dst_share` enables cross-share move on the same host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Source share |
| `src_relative_path` | string | Source path |
| `dst_relative_path` | string | Destination path |
| `dst_share` | string? | Destination share for cross-share move |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `create_directory`

Create a directory and any missing parents.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Directory path to create |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `delete`

Delete a file or directory. If the target is a directory and `recursive` is absent or `false`, returns a summary (`size_bytes`, `file_count`) with `requires_confirmation: true` instead of deleting — re-call with `recursive: true` to proceed.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `relative_path` | string | Path to delete |
| `recursive` | boolean? | Required to delete a non-empty directory |
| `host` | string? | |

**Output (file or confirmed delete)**: `{ ok: true }`

**Output (directory, confirmation required)**: `{ requires_confirmation: true, path, size_bytes, file_count }`

---

## Example Prompts

| Prompt | Tools used |
|---|---|
| "What machines do I have connected?" | `list_hosts` |
| "Show me the structure of my projects directory" | `list_directory` with `recursive: true` |
| "Find all `.env` files in my projects" | `find_files` |
| "Fix the bug in `src/auth.ts`" | `read_file`, then `edit_file` |

---

## Management API

All `/api/*` endpoints require a `relay:manage`-scoped Bearer token obtained via `constellation relay login`. Tokens without that scope receive `403 insufficient_scope`.

Admin-only endpoints additionally require the session to be elevated (see `relay elevate`). Requests without admin privileges receive `403 ESCALATION_REQUIRED`.

All error responses follow:
```json
{ "error": "<code>", "error_description": "<human-readable>" }
```

List endpoints support pagination via `limit` (default 100, max 1000) and `offset` (default 0) query parameters and return:
```json
{ "data": [...], "total": <n>, "limit": <n>, "offset": <n> }
```

### `GET /api/status`

Relay health check. No auth required.

**Response `200`**
```json
{ "status": "ok", "uptime_seconds": 3724, "version": "0.2.3" }
```

---

### `GET /api/me`

Returns the current session ID and user ID. Used internally by `relay elevate` to identify the session to escalate.

**Response `200`**
```json
{ "session_id": "...", "user_id": "..." }
```

---

### `GET /api/executors`

List all executors registered to the authenticated user.

**Response `200`** — paginated:

| Field | Type | Description |
|---|---|---|
| `id` | string | Executor ID (cuid) |
| `host` | string | Host name |
| `registered_at` | ISO 8601 | When the executor was first registered |
| `last_heartbeat_at` | ISO 8601 \| null | Last successful heartbeat pong |
| `last_disconnect_reason` | string \| null | Reason for last WebSocket disconnect, if any |
| `online` | boolean | Whether the last heartbeat is within the threshold |
| `connected` | boolean | Whether a live WebSocket is open right now |
| `token_id` | string | Current executor token ID |
| `token_last_used_at` | ISO 8601 \| null | Last time the token authenticated a connection |
| `shares` | `{ share, reported_path }[]` | Path shares reported by the executor |

---

### `DELETE /api/executors/:id/token`

Revoke an executor's token. Any active WebSocket for that executor is terminated immediately.

| Status | Meaning |
|---|---|
| `204` | Token revoked |
| `404` | Executor not found or belongs to another user |
| `409` | Token already revoked |

---

### `GET /api/shares`

List path shares for the authenticated user.

**Query params**: `executor_id` — filter to a specific executor (optional).

**Response `200`** — paginated:

| Field | Type |
|---|---|
| `id` | string |
| `share` | string |
| `reported_path` | string |
| `executor_id` | string |
| `host` | string |

---

### `GET /api/filters`

List active relay path filters.

**Response `200`** — paginated:

| Field | Type | Description |
|---|---|---|
| `id` | string | Filter ID |
| `pattern` | string | Glob or regex pattern |
| `pattern_type` | `"glob"` \| `"regex"` | |
| `scope_executor_id` | string \| null | Null = applies to all executors |
| `created_at` | ISO 8601 | |

---

### `POST /api/filters`

Add a relay path filter.

**Request body**:

| Field | Required | Description |
|---|---|---|
| `pattern` | yes | Glob or regex string (max 1000 characters) |
| `pattern_type` | yes | `"glob"` or `"regex"` |
| `executor_id` | no | Scope to a specific executor; omit for all executors |

**Response `201`** — the created filter object.

| Status | Meaning |
|---|---|
| `201` | Filter created |
| `400` | Missing/invalid fields, invalid regex, or pattern too long |
| `404` | `executor_id` not found for this user |

---

### `DELETE /api/filters/:id`

Remove a path filter.

| Status | Meaning |
|---|---|
| `204` | Deleted |
| `404` | Not found or belongs to another user |

---

### `GET /api/sessions`

List active MCP client OAuth sessions (non-expired only).

**Response `200`** — paginated:

| Field | Type | Description |
|---|---|---|
| `id` | string | Session ID |
| `mcp_client_id` | string | OAuth client that holds this session |
| `is_dynamic_client` | boolean | Whether the client registered via Dynamic Client Registration |
| `issued_at` | ISO 8601 | |
| `expires_at` | ISO 8601 | Access token expiry |
| `has_refresh_token` | boolean | |
| `refresh_token_expires_at` | ISO 8601 \| null | |

---

### `DELETE /api/sessions/:id`

Revoke an OAuth session. Both access and refresh tokens are invalidated immediately.

| Status | Meaning |
|---|---|
| `204` | Session revoked |
| `404` | Not found or belongs to another user |

---

### `POST /api/tokens/shared`

Break-glass hub token creation. Requires an elevated admin session. Creates a user-less `HUB` token that a hub can use to authenticate. The preferred path is `constellation hub register` — use this endpoint only when the device code flow is unavailable.

**Response `201`**
```json
{ "token": "...", "token_id": "...", "created_at": "..." }
```

The token is returned once and not stored. Revoke via `DELETE /api/executors/:id/token`.

---

### `GET /api/users` · `POST /api/users` · `POST /api/users/:username/deactivate` · `POST /api/users/:username/reset-password`

User management endpoints. Available in `AUTH_MODE=local` only — return `404` in `AUTH_MODE=oidc`. All require an elevated admin session.

**`GET /api/users`** — list all local users. Paginated.

**Response `200`**
```json
{
  "data": [
    {
      "id": "...",
      "username": "alice",
      "is_active": true,
      "created_at": "2026-05-25T12:00:00.000Z",
      "last_login_at": "2026-05-25T14:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

**`POST /api/users`** — create a new local user. Body: `{ username, password }`. Password must be at least 12 characters. Returns `409` if the username is already taken.

**`POST /api/users/:username/deactivate`** — deactivate a user. Marks the user account as deactivated; every existing session and executor connection for that user is rejected on its very next request, not just future logins.

**`POST /api/users/:username/reset-password`** — set a new password. Body: `{ password }`. Immediately invalidates all existing OAuth sessions for that user.

---

### `POST /api/admin/users/:identifier/promote`

Grant admin role to a user. `<identifier>` is the OIDC sub or (in `AUTH_MODE=local`) the username. Protected by `RELAY_ADMIN_TOKEN` — not an OAuth-gated route.

| Status | Meaning |
|---|---|
| `204` | Role updated |
| `401` | Invalid or missing admin token |
| `404` | User not found, or `RELAY_ADMIN_TOKEN` not set |

---

### `POST /api/admin/users/:identifier/demote`

Revoke admin role from a user. Same auth requirements as promote.

| Status | Meaning |
|---|---|
| `204` | Role updated |
| `401` | Invalid or missing admin token |
| `404` | User not found, or `RELAY_ADMIN_TOKEN` not set |

---

### `GET /api/admin/hub-shares`

List all hub shares synced to the relay from hubs. Requires an elevated admin session.

**Query params**: `executor` — filter to a specific hub by ID (optional).

**Response `200`**
```json
{
  "data": [
    {
      "executor_id": "...",
      "executor_host": "prod-server",
      "share": "projects",
      "reported_path": "/srv/projects",
      "permission_blob": {
        "default": "read",
        "overrides": [{ "oidc_sub": "user|abc", "access": "write" }]
      },
      "updated_at": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/account/deactivate`

Deactivate the authenticated user's account. All subsequent token lookups will fail.

**Request body**
```json
{ "confirm": "deactivate my account" }
```

| Status | Meaning |
|---|---|
| `204` | Account deactivated |
| `400` | Confirmation string missing or wrong |
