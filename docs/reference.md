# Constellation Reference

- [Agent CLI](#agent-cli)
- [Shared Agent CLI](#shared-agent-cli)
- [Agent GUI](#agent-gui)
- [Broker CLI](#broker-cli)
- [MCP Tools](#mcp-tools)
- [Management API](#management-api)

---

## Agent CLI

```sh
constellation [--config <dir>] <command>
```

`--config <dir>` and `CONSTELLATION_CONFIG_DIR` both override the default config directory (`~/.config/constellation/` on Linux/macOS, `%APPDATA%\constellation\` on Windows).

### `agent init`

```sh
constellation agent init --broker <url>
```

Runs the device code OAuth flow, creates an agent registration on the broker, and writes `agent.yaml` and an empty `paths.yaml`. Safe to re-run — rewrites credentials without touching existing path config.

### `agent install`

```sh
constellation agent install
```

Registers the agent with the OS service manager for user-scoped autostart. Does not require root/admin.

| Platform | Mechanism | Location |
|---|---|---|
| Linux | systemd user unit | `~/.config/systemd/user/constellation-agent.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.constellation.agent.plist` |
| Windows | Task Scheduler | Task named `constellation-agent` |

### `agent start` / `stop` / `restart`

Start, stop, and restart the agent service. `start --foreground` runs the daemon directly in the current process.

### `agent status [--json]`

Shows service state (active/inactive/unknown), broker URL, host name, and configured labels. `--json` emits a machine-readable object.

### `agent sync`

Opens a one-shot WebSocket connection, pushes the current `paths.yaml` to the broker, and exits. Only needed after manually editing `paths.yaml` — `agent paths add` and `agent paths remove` sync automatically.

### `agent rotate`

Requests a token rotation from the broker. The new token is written to `agent.yaml`. Restart the agent service afterwards to reconnect with the new token.

### `agent rename <host>`

Pushes a new host name to the broker and updates `agent.yaml`. Fails if another agent on the same account already uses that name.

### `agent logs [-f] [--lines <n>]`

Displays agent service logs. Defaults to 50 lines. `-f` follows the log stream.

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

Prints the resolved config directory path.

### `agent paths list [--json]`

Lists labels and paths from `paths.yaml`.

### `agent paths add <label> <path> [--instructions <text>]`

Appends an entry to `paths.yaml` and syncs to the broker immediately. `--instructions` sets inline text (max 500 characters) surfaced to MCP clients via `list_labels`; see [`paths.yaml`](configuration.md#pathsyaml) for the relationship with `context_file`.

### `agent paths remove <label>`

Removes an entry from `paths.yaml` and syncs to the broker immediately.

---

## Shared Agent CLI

The shared agent is a system-level daemon that serves files to multiple users from a single process. It reads from a YAML config file and authenticates via `CONSTELLATION_AGENT_TOKEN` in the environment (typically sourced from an env file).

Every subcommand below that takes `--config <path>` resolves it the same way: the flag, then `$CONSTELLATION_SHARED_AGENT_CONFIG`, then `/etc/constellation/shared-agent.yaml` — so `--config` can be omitted when using the conventional path.

### `shared-agent register`

```sh
constellation shared-agent register --broker-url <url> [--host-name <name>] [--env-file <path>]
```

Starts a device code OAuth flow that requires admin approval. Once approved, writes the service token to the env file (default `/etc/constellation/shared-agent.env`, mode 0600). The token is never printed to the terminal.

| Flag | Default | Description |
|---|---|---|
| `--broker-url` | `$BROKER_URL` | Broker URL (required) |
| `--host-name` | system hostname | Name for this agent on the broker |
| `--env-file` | `/etc/constellation/shared-agent.env` | Path to write `CONSTELLATION_AGENT_TOKEN` |

### `shared-agent validate-config`

```sh
constellation shared-agent validate-config [--config <path>]
```

Dry-run validation of a shared agent config file. Checks schema, label path existence, `user_map` username resolution, and token availability. Exits non-zero on error.

### `shared-agent start`

```sh
constellation shared-agent start [--config <path>]
```

Starts the shared agent daemon.

### `shared-agent status [--json]`

```sh
constellation shared-agent status [--config <path>]
```

Prints agent name, broker URL, and label list from the config file.

### `shared-agent install`

```sh
constellation shared-agent install [--config <path>] [--unit-name <name>] [--user <user>]
```

Prints a systemd system unit file to stdout. Redirect it to `/etc/systemd/system/<unit-name>.service` and run `systemctl daemon-reload && systemctl enable --now <unit-name>`.

| Flag | Default | Description |
|---|---|---|
| `--unit-name` | `constellation-shared-agent` | Systemd unit name |
| `--user` | `constellation` | Service user (must have `CAP_SETUID`/`CAP_SETGID`) |

### `shared-agent stop`

```sh
constellation shared-agent stop [--unit-name <name>]
```

Stops the systemd unit (calls `systemctl stop`). If the agent is not managed by systemd, send `SIGTERM` to the process manually.

### `shared-agent rotate-token`

```sh
constellation shared-agent rotate-token [--config <path>]
```

Rotates the agent token via a WebSocket connection and writes the new token to the `env_file` specified in the config. Restart the agent afterwards to reconnect.

---

## Agent GUI

The agent GUI is a system tray application for desktop machines. Every action it exposes is a wrapper around the corresponding `constellation agent` CLI command — there is no functionality available in the GUI that cannot be performed from the CLI.

Download: [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest). The CLI must also be installed and available on `PATH`.

### Tray menu

The tray icon reflects connection state (blue = connected, yellow = connecting, grey = stopped/unconfigured, red = unexpectedly disconnected). The menu adapts based on whether the agent is configured.

**Configured:**
- **Status & Logs** — open the Status window
- **Paths** — open the Paths window
- **Settings** — open the Settings window
- **Start / Stop / Restart** — run `constellation agent start/stop/restart`
- **Quit**

**Unconfigured** (no `agent.yaml` or missing credentials):
- **Connect to Broker** — open the Auth window
- **Quit**

### Auth window

Runs the device code OAuth flow (`constellation agent init`). Enter the broker URL, then approve the login in your browser. On success, writes `agent.yaml` and creates `paths.yaml` if absent.

### Status window

Shows live agent state polled every 5 seconds: connection status, broker URL, last heartbeat, host name, token dates, service state, and the last 50 lines of service logs. **Start / Stop / Restart** buttons run the corresponding CLI commands.

### Paths window

Displays entries from `paths.yaml` in a table. Adding a path calls `constellation agent paths add`; removing one calls `constellation agent paths remove`. Both sync to the broker immediately. A native folder picker is available when adding a path.

### Settings window

Edits `agent.yaml` fields:

| Field | Action |
|---|---|
| Broker URL | Written directly to `agent.yaml`; requires an agent restart to take effect |
| Agent name (host) | Calls `constellation agent rename` on save |
| Max file size (KB) | Written directly to `agent.yaml`; range 1–100 |
| Config directory | Read-only display |

**Danger zone** (collapsed by default):
- **Rotate token** — calls `constellation agent rotate`; fires an OS notification on success
- **Deregister agent** — prompts for confirmation, deletes `agent.yaml`, resets to unconfigured state

---

## Broker CLI

These commands manage the broker remotely via the management API. Requires `constellation broker login` first. The session in `broker-session.yaml` is refreshed silently as needed.

### `broker login [--broker <url>]`

Runs the device code OAuth flow for `broker:manage` scope. Writes session to `broker-session.yaml`. Broker URL defaults to the one in `agent.yaml` if not specified.

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

### `broker users list [--json]`

Lists all local user accounts. Only available when the broker is running in `AUTH_MODE=local`.

### `broker users add <username>`

Creates a new local user. Prompts for a password (minimum 12 characters).

### `broker users remove <username>`

Deactivates a local user (soft delete). Prompts for confirmation. Existing sessions expire normally; no future logins are permitted.

### `broker users reset-password <username>`

Sets a new password for a local user and immediately invalidates all of their existing OAuth sessions. Prompts for the new password (minimum 12 characters).

### `broker account deactivate`

Deactivates your account after an interactive confirmation prompt. All agent connections and MCP client sessions are immediately blocked. Re-running `constellation agent init` is required to restore access.

### `broker elevate`

```sh
constellation broker elevate [--broker <url>]
```

Requests temporary admin access via a browser-approved device code flow (step-up authentication). Opens the approval URL automatically. On success, the current `broker:manage` session is elevated and subsequent admin-required commands succeed. Admin approval is required; the request is denied if the account does not have admin privileges.

### `broker user promote <identifier>`

```sh
constellation broker user promote <identifier> [--admin-token <token>] [--broker <url>]
```

Grants admin role to a user. `<identifier>` is the OIDC sub or (in `AUTH_MODE=local`) the username. Requires `BROKER_ADMIN_TOKEN` env var or `--admin-token` flag — this is a bootstrap operation not gated by OAuth.

### `broker user demote <identifier>`

```sh
constellation broker user demote <identifier> [--admin-token <token>] [--broker <url>]
```

Revokes admin role from a user. Same auth requirements as `broker user promote`.

### `broker shared-labels list [--agent <id>] [--json]`

Lists all shared labels synced to the broker. Requires an elevated admin session (`broker elevate` first). `--agent` filters to a specific shared agent by ID.

### `broker token create --shared`

```sh
constellation broker token create --shared
```

Break-glass operation: creates a shared agent service token without going through the device code flow. Use only when `constellation shared-agent register` is unavailable (e.g. scripted provisioning). Requires an elevated admin session. The token is shown once — store it immediately. Displays a prominent warning before proceeding.

---

## MCP Tools

Tools are called by MCP clients (Claude, ChatGPT, Cursor) after authenticating via OAuth. Every tool that operates on files takes a `label` (a named path root registered by an agent) and optionally a `host` to disambiguate when the same label name exists on multiple machines.

### Agent-enforced caps

These limits are applied by the agent regardless of broker settings.

| Tool | Limit |
|---|---|
| `list_directory` | Default 2,000 nodes per call; hard cap 10,000. Set `limit` to override (capped at 10,000). Returns `truncated: true` and `truncated_by` when the limit is hit. |
| `find_files` | 200 results. Returns `truncated: true` when hit. |
| `grep_files` | 50 total matches or 100 KB of output, whichever comes first. Files larger than 10 MB are skipped silently. Returns `truncated: true` when hit. |
| `read_file` | `max_file_size_kb` from `agent.yaml` (default 100 KB) per call. Applies to both full reads and range reads. Use `start_line`/`end_line` to page through large files; `total_lines` in the response tells you when to stop. |
| `copy` / `move` | Fails if the destination already exists. Cross-device `move` falls back to copy + delete automatically. |
| `delete` (directory) | Without `recursive: true`, returns a dry-run summary (`size_bytes`, `file_count`, `requires_confirmation: true`). Re-call with `recursive: true` to proceed. |

---

### `list_hosts`

List all registered hosts with online status and their labels.

**Input**: none

**Output**:

| Field | Type |
|---|---|
| `hosts` | `{ host, online, last_seen, labels }[]` |

---

### `list_labels`

List path labels, optionally filtered by host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `host` | string? | Filter to a specific host |

**Output**: `{ labels: { label, host, instructions, modality, access }[] }`

`instructions` is the label's configured inline text or `context_file` contents (or `null` if neither is set, the cap was exceeded, or the file couldn't be read). Capped at 500 characters — see [`paths.yaml`](configuration.md#pathsyaml).

---

### `list_directory`

Enumerate directory contents — names and types. Use `recursive: true` with `exclude: ["node_modules", ".git"]` for repo trees.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Path root label |
| `relative_path` | string? | Subdirectory within the label root (defaults to root) |
| `recursive` | boolean? | Recurse into subdirectories |
| `max_depth` | integer? | Maximum recursion depth |
| `limit` | integer? | Max nodes returned; default 2,000, hard cap 10,000 |
| `exclude` | string[]? | Directory names to skip during recursion |
| `host` | string? | Disambiguate when multiple hosts share a label name |

**Output**: `{ nodes: { path, type }[], total_nodes, truncated, truncated_by? }`

`truncated_by` is `"limit"` or `"max_depth"`.

---

### `file_info`

Return metadata for a single path without reading its contents.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Path root label |
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
| `label` | string | Path root label |
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
| `label` | string | Path root label |
| `relative_path` | string | Path to the file |
| `start_line` | integer? | First line to return (1-based) |
| `end_line` | integer? | Last line to return (inclusive) |
| `host` | string? | |

**Output**: `{ content, total_lines }`

Files exceeding `max_file_size_kb` (agent config, default 100 KB) return `FILE_TOO_LARGE`. Range reads that exceed the cap return `READ_TOO_LARGE` — narrow the range.

---

### `grep_files`

Search file contents for a literal string or regex. Does not match filenames. Results are grouped by file, capped at 50 matches or 100 KB of output, whichever comes first. Files larger than 10 MB are skipped.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Path root label |
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
| `label` | string | Path root label |
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
| `label` | string | Path root label |
| `relative_path` | string | Path to the file |
| `edits` | `{ old_text, new_text }[]` | List of substitutions to apply |
| `dry_run` | boolean? | Return the diff without writing |
| `host` | string? | |

**Output**: `{ diff }` — unified diff of the applied changes.

---

### `copy`

Copy a file or directory. Fails if the destination already exists. `dst_label` enables cross-label copy on the same host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Source label |
| `src_relative_path` | string | Source path within the label |
| `dst_relative_path` | string | Destination path |
| `dst_label` | string? | Destination label for cross-label copy |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `move`

Move a file or directory. Removes the source after copying. Fails if the destination already exists. `dst_label` enables cross-label move on the same host.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Source label |
| `src_relative_path` | string | Source path |
| `dst_relative_path` | string | Destination path |
| `dst_label` | string? | Destination label for cross-label move |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `create_directory`

Create a directory and any missing parents.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Path root label |
| `relative_path` | string | Directory path to create |
| `host` | string? | |

**Output**: `{ ok: true }`

---

### `delete`

Delete a file or directory. If the target is a directory and `recursive` is absent or `false`, returns a summary (`size_bytes`, `file_count`) with `requires_confirmation: true` instead of deleting — re-call with `recursive: true` to proceed.

**Input**:

| Param | Type | Description |
|---|---|---|
| `label` | string | Path root label |
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

All `/api/*` endpoints require a `broker:manage`-scoped Bearer token obtained via `constellation broker login`. Tokens without that scope receive `403 insufficient_scope`.

Admin-only endpoints additionally require the session to be elevated (see `broker elevate`). Requests without admin privileges receive `403 ESCALATION_REQUIRED`.

All error responses follow:
```json
{ "error": "<code>", "error_description": "<human-readable>" }
```

List endpoints support pagination via `limit` (default 100, max 1000) and `offset` (default 0) query parameters and return:
```json
{ "data": [...], "total": <n>, "limit": <n>, "offset": <n> }
```

### `GET /api/status`

Broker health check. No auth required.

**Response `200`**
```json
{ "status": "ok", "uptime_seconds": 3724, "version": "0.2.3" }
```

---

### `GET /api/me`

Returns the current session ID and user ID. Used internally by `broker elevate` to identify the session to escalate.

**Response `200`**
```json
{ "session_id": "...", "user_id": "..." }
```

---

### `GET /api/agents`

List all agents registered to the authenticated user.

**Response `200`** — paginated:

| Field | Type | Description |
|---|---|---|
| `id` | string | Agent ID (cuid) |
| `host` | string | Host name |
| `registered_at` | ISO 8601 | When the agent was first registered |
| `last_heartbeat_at` | ISO 8601 \| null | Last successful heartbeat pong |
| `last_disconnect_reason` | string \| null | Reason for last WebSocket disconnect, if any |
| `online` | boolean | Whether the last heartbeat is within the threshold |
| `connected` | boolean | Whether a live WebSocket is open right now |
| `token_id` | string | Current agent token ID |
| `token_last_used_at` | ISO 8601 \| null | Last time the token authenticated a connection |
| `labels` | `{ label, reported_path }[]` | Path labels reported by the agent |

---

### `DELETE /api/agents/:id/token`

Revoke an agent's token. Any active WebSocket for that agent is terminated immediately.

| Status | Meaning |
|---|---|
| `204` | Token revoked |
| `404` | Agent not found or belongs to another user |
| `409` | Token already revoked |

---

### `GET /api/labels`

List path labels for the authenticated user.

**Query params**: `agent_id` — filter to a specific agent (optional).

**Response `200`** — paginated:

| Field | Type |
|---|---|
| `id` | string |
| `label` | string |
| `reported_path` | string |
| `agent_id` | string |
| `host` | string |

---

### `GET /api/filters`

List active broker path filters.

**Response `200`** — paginated:

| Field | Type | Description |
|---|---|---|
| `id` | string | Filter ID |
| `pattern` | string | Glob or regex pattern |
| `pattern_type` | `"glob"` \| `"regex"` | |
| `scope_agent_id` | string \| null | Null = applies to all agents |
| `created_at` | ISO 8601 | |

---

### `POST /api/filters`

Add a broker path filter.

**Request body**:

| Field | Required | Description |
|---|---|---|
| `pattern` | yes | Glob or regex string (max 1000 characters) |
| `pattern_type` | yes | `"glob"` or `"regex"` |
| `agent_id` | no | Scope to a specific agent; omit for all agents |

**Response `201`** — the created filter object.

| Status | Meaning |
|---|---|
| `201` | Filter created |
| `400` | Missing/invalid fields, invalid regex, or pattern too long |
| `404` | `agent_id` not found for this user |

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

Break-glass shared agent token creation. Requires an elevated admin session. Creates a user-less `SHARED` token that a shared agent can use to authenticate. The preferred path is `constellation shared-agent register` — use this endpoint only when the device code flow is unavailable.

**Response `201`**
```json
{ "token": "...", "token_id": "...", "created_at": "..." }
```

The token is returned once and not stored. Revoke via `DELETE /api/agents/:id/token`.

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

**`POST /api/users/:username/deactivate`** — deactivate a user. Blocks all future logins and marks the user account as deactivated. Existing sessions expire normally.

**`POST /api/users/:username/reset-password`** — set a new password. Body: `{ password }`. Immediately invalidates all existing OAuth sessions for that user.

---

### `POST /api/admin/users/:identifier/promote`

Grant admin role to a user. `<identifier>` is the OIDC sub or (in `AUTH_MODE=local`) the username. Protected by `BROKER_ADMIN_TOKEN` — not an OAuth-gated route.

| Status | Meaning |
|---|---|
| `204` | Role updated |
| `401` | Invalid or missing admin token |
| `404` | User not found, or `BROKER_ADMIN_TOKEN` not set |

---

### `POST /api/admin/users/:identifier/demote`

Revoke admin role from a user. Same auth requirements as promote.

| Status | Meaning |
|---|---|
| `204` | Role updated |
| `401` | Invalid or missing admin token |
| `404` | User not found, or `BROKER_ADMIN_TOKEN` not set |

---

### `GET /api/admin/shared-labels`

List all shared labels synced to the broker. Requires an elevated admin session.

**Query params**: `agent` — filter to a specific shared agent by ID (optional).

**Response `200`**
```json
{
  "data": [
    {
      "agent_id": "...",
      "agent_host": "prod-server",
      "label": "projects",
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
