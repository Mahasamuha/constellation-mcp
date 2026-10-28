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
constellation node init --relay <url> [--host-name <name>] [--accept-new-issuer]
```

Signs in to the relay's authorization server (asterism) with the OAuth device flow (scope `relay register`, client `<relay>/clients/node.json`). `register` is a step-up scope that needs a fresh sign-in, so expect to be asked for your password even if you are already signed in at the authorization server. Then calls `POST /api/executors/register` with `type: "node"` and the host name to create the node registration. Writes `node.yaml` and an empty `paths.yaml`. Safe to re-run — rewrites credentials without touching existing path config.

`--host-name` (1–63 characters) defaults to the host from an existing `node.yaml`, else the machine's hostname. The sign-in access token is used once and not stored; the node token in `node.yaml` is the long-lived credential. The relay's answer is checked before it is stored: the token must be 64 lowercase hex characters and the host name 1-63 characters of letters, digits, `.`, `_`, `-`.

`node.yaml` also records `issuer`, the authorization server used. Re-running `node init` for the same relay is pinned to it: if the relay now names another one, nothing is sent to it and the command stops. Pass `--accept-new-issuer` if you trust the change.

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

Requests a token rotation from the relay. Without a running daemon, the new token is written to `node.yaml` and then confirmed by connecting with it; the displaced token is kept as `previous_node_token` until that connection succeeds. The node only acts on a rotation it requested itself, and refuses any token that is not 64 lowercase hex characters. Restart the node service afterwards to reconnect with the new token.

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

### `node config set [--relay-url <url>] [--max-file-size-kb <n>] [--json]`

Updates `relay_url` and `max_file_size_kb` without re-registering. The node token was issued by the relay it registered with, so changing `--relay-url` to a different origin (scheme, host or port) removes `node_token`, `previous_node_token` and `issuer` from `node.yaml`, and the command says to run `constellation node init --relay <url>`. A change that keeps the origin (a trailing slash, letter case) keeps the credentials. `--json` prints `{"ok":true,"credentials_dropped":<bool>}`; node-gui uses it.

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

Starts an OAuth device flow against the relay's authorization server (asterism) with scope `relay admin register` and client `<relay>/clients/hub.json`. Only members of the admin group can approve it, and `register` needs a fresh sign-in (the admin is asked for their password even if already signed in). The approved admin token (5 minutes, not stored) is then used for `POST /api/executors/register` with `type: "hub"`; the resulting service token is written to the env file (default `/etc/constellation/hub.env`, mode 0600, replaced atomically; other lines are kept). A token that is not 64 lowercase hex characters is refused. The token is never printed to the terminal. The env file also gets `CONSTELLATION_HUB_ISSUER`, the authorization server used; a repeat registration is pinned to it (`--accept-new-issuer` overrides).

| Flag | Default | Description |
|---|---|---|
| `--relay` | `$RELAY_URL` | Relay URL (required) |
| `--host-name` | system hostname | Name for this hub on the relay |
| `--env-file` | `/etc/constellation/hub.env` | Path to write `CONSTELLATION_HUB_TOKEN` |
| `--accept-new-issuer` | off | Trust the authorization server the relay names now, although this hub registered with another |

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

Prints hub name, relay URL, share list, and the audit log's path with free/total
disk space on the filesystem holding it (`null` in `--json` output if that directory
doesn't exist yet) — `writeAuditEntry` fails open on a full disk rather than blocking
tool calls, so this is the signal to catch it before audit coverage silently drops.

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

If the hub is currently running, asks it to rotate on its own live connection — persists the new token to `env_file` and reconnects immediately, no restart needed. Otherwise rotates via a direct WebSocket connection and writes the new token to `env_file`; restart the hub afterwards to connect with it.

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

Runs the same sign-in and registration as `constellation node init`. Enter the relay URL, then approve the login in your browser (on the authorization server's page). On success, writes `node.yaml` and creates `paths.yaml` if absent. The host name is the one already in `node.yaml`, else the machine's hostname.

### Status window

Shows live node state polled every 5 seconds: connection status, relay URL, last heartbeat, host name, token dates, service state, and the last 50 lines of service logs. **Start / Stop / Restart** buttons run the corresponding CLI commands.

### Paths window

Displays entries from `paths.yaml` in a table. Adding a path calls `constellation node paths add`; removing one calls `constellation node paths remove`. Both sync to the relay immediately. A native folder picker is available when adding a path.

### Settings window

Edits `node.yaml` fields:

| Field | Action |
|---|---|
| Relay URL | Written via `node config set`; a different origin removes the node token and the window says to connect again |
| Node name (host) | Calls `constellation node rename` on save |
| Max file size (KB) | Written directly to `node.yaml`; range 1–100 |
| Config directory | Read-only display |

**Danger zone** (collapsed by default):
- **Rotate token** — calls `constellation node rotate`; fires an OS notification on success
- **Deregister node** — prompts for confirmation, deletes `node.yaml`, resets to unconfigured state

---

## Relay CLI

These commands manage the relay remotely via the management API. Requires `constellation relay login` first. The session in `relay-session.yaml` is refreshed silently as needed.

The session holds an asterism access token and a rotating refresh token (scope `relay offline_access`, client `<relay>/clients/cli.json`):

```yaml
relay_url: https://relay.example.com
access_token: <JWT>
access_token_expires_at: 2026-10-27T12:00:00.000Z
refresh_token: <opaque>
refresh_token_expires_at: 2026-11-26T11:00:00.000Z   # absolute, 30 days from login
```

The shape is unchanged from earlier versions, but tokens issued by the old relay no longer work: sign in again after upgrading. Refreshes are serialized across processes with `relay-session.yaml.lock`, and the rotated refresh token is written before the new access token is used. When the refresh token is spent, revoked (for example in asterism's `/grants`) or past its 30 days, the command says "Session expired"; run `relay login` again (in an interactive terminal it starts the sign-in for you).

Commands that need admin (`relay hub-shares list`) do a second device flow with scope `relay admin` and no `offline_access`, only for that command. The admin token is kept in memory and never written to disk; it needs membership in asterism's `constellation-admins` group. There is no `relay elevate`.

User accounts, admin roles and sessions are managed in asterism, not here: use asterism's `/grants` page to review or revoke what each client may do, and asterism's `local-user` CLI to manage local accounts.

`--config-dir <dir>` (e.g. `constellation relay --config-dir /path login`) and `CONSTELLATION_CONFIG_DIR` override the default config directory where `relay-session.yaml` is read and written.

`--relay <url>` is declared on the `relay` command itself, not on `login` or any other subcommand individually — it must appear somewhere after `relay` on the command line. The recommended, always-safe position is right after `relay` and before the subcommand (e.g. `constellation relay --relay <url> login`).

### `relay login`

```sh
constellation relay --relay <url> login [--accept-new-issuer]
```

Runs the OAuth device flow against the relay's authorization server (scope `relay offline_access`). Writes the session to `relay-session.yaml`, including `issuer`, the authorization server that issued it. Later refreshes go only to that issuer: if the relay starts naming a different one, the command refuses, keeps the session and tells you to run `relay login` deliberately. Every later sign-in for the same session (the automatic one after expiry, and the admin step-up) is pinned to that issuer too. An explicit `relay login` that finds the relay naming a different issuer than your session shows both and asks for confirmation; without a terminal it refuses unless you pass `--accept-new-issuer`. A session written before `issuer` was recorded needs a new `relay login`. Relay URL defaults to the one in `node.yaml` if not specified.

### `relay logout`

Revokes the refresh token at asterism's revocation endpoint (best effort, short timeout; `client_id` is sent), then deletes `relay-session.yaml`. If revocation fails a note is printed and the file is still deleted; the grant itself stays, and you can end it in asterism's `/grants` page.

### `relay status`

Shows relay health, uptime, and version.

### `relay executors list [--limit <n>] [--offset <n>] [--json]`

Lists all executors registered to your account with their online status and shares. Paginated like the underlying API (see "Management API" below) — defaults to `--limit 100 --offset 0`; if more rows exist than fit on the current page, a "Showing N of total" note is printed to stderr (so `--json` output stays valid, pipeable JSON either way).

### `relay executors revoke <executor-id>`

Revokes the executor's token. The executor goes offline immediately and cannot reconnect until re-initialized. Prompts for confirmation.

### `relay shares list [--executor <id>] [--limit <n>] [--offset <n>] [--json]`

Lists path shares across all executors, optionally filtered to a specific executor ID. Paginated — see `relay executors list` above.

### `relay filters list [--limit <n>] [--offset <n>] [--json]`

Lists active relay-side path deny filters. Paginated — see `relay executors list` above.

### `relay filters add <pattern> [--type glob|regex] [--executor <id>]`

Adds a deny filter. `--type` defaults to `glob`. `--executor` scopes it to a specific executor; omit to apply to all executors.

### `relay filters remove <filter-id>`

Removes a deny filter by ID.

### `relay hub-shares list [--executor <id>] [--json]`

Lists all hub shares synced to the relay. Asks you to approve an admin sign-in (see above). `--executor` filters to a specific hub by ID.

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
| `read_file` | `max_file_size_kb` from `node.yaml`/`hub.yaml` (default 100 KB) per call. Applies to both full reads and range reads. Use `start_line`/`end_line` to page through large files; `total_lines` in the response tells you when to stop. |
| `copy` / `move` | Fails if the destination already exists. Cross-device `move` falls back to copy + delete automatically. |
| `delete` (directory) | Without `recursive: true`, returns a dry-run summary (`size_bytes`, `file_count`, `requires_confirmation: true`). Re-call with `recursive: true` to proceed. |

### Tool call errors

A tool call can fail before it ever reaches a node or hub — share/host resolution, path
filters, and rate limiting all happen at the relay first. These aren't returned as a
structured error code over MCP; like any other tool error, the client just sees the
message text below as the call's result. The codes are how the relay's own code and
logs refer to each case (`packages/relay/src/router.ts`'s `RouterError`) — listed here
as labels for cross-referencing, not as something you'll see directly.

| Code | Trigger | Message you'll see |
|---|---|---|
| `share_not_found` | No share with that name is registered to you (or, for hub shares, visible to you) | `No share '<share>' found` |
| `host_not_found` | `host` param given, but no host with that name exists for you | `No host '<host>' found` |
| `ambiguous` | A hub share name is visible to you on more than one host | `Share '<share>' is available on multiple hosts you have access to: <hosts>. Specify host to disambiguate.` |
| `cross_host` | `copy`/`move` with `dst_share` resolving to a different host than the source share | `'<share>' is on '<host>' and '<dst_share>' is on '<dst_host>' — cross-host move/copy is not supported` |
| `path_filtered` | The resolved path matches a relay-side [path filter](relay.md#path-filters) | `Path blocked by relay filter: <share>/<relative_path>` |
| `executor_offline` | The share's executor isn't currently connected (checked before dispatch, or disconnected before responding) | `'<share>' is on '<host>', which was last seen <relative time, or 'never'>` |
| `timeout` | The executor was connected but didn't respond within `RPC_TIMEOUT_MS` | `No response from '<host>' within <N>s` |
| `rate_limited` | Per-user rate limit exceeded for this tool, checked before dispatch | `Rate limit exceeded. Please slow down.` |

`executor_offline`, `timeout`, and `rate_limited` also show up as `error_code` /
`event_type` values in [`GET /api/activity`](#get-apiactivity). The other five aren't
logged to the activity feed at all — they're returned directly to the failing call only.

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
| `exclude` | string[]? | Glob patterns matched against entry names (e.g. `node_modules`, `*.log`); matching entries are skipped. See [Pattern syntax](#pattern-syntax) |
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

### Pattern syntax

`find_files`, `grep_files` (`file_glob`, and `type: "regex"`) and `list_directory` (`exclude`) share one linear-time engine (RE2), so a pattern can't stall a node.

- **Globs** are matched against the entry name (the file or directory name, not its path), and the whole name must match. `*` and `?` match within a name, `**` matches anything, `[abc]` and `[!abc]` are character classes, and `{a,b}` is an alternation. Dotfiles match like any other name. Extglobs (`+(a|b)`) and POSIX classes (`[[:alpha:]]`) are not supported.
- **Regex** is RE2 syntax: no lookarounds (`(?=`, `(?!`, `(?<=`) and no backreferences (`\1`). It is matched anywhere in the name (`find_files`) or line (`grep_files`) and is case-sensitive; anchor with `^` and `$`, or use `(?i)` for case-insensitive.
- A pattern must be 1-1000 characters. An invalid or unsupported pattern fails the call with code `INVALID_PATTERN`.

---

### `find_files`

Find files by name using glob or regex. Matches filenames and paths only — does not search file contents. Capped at 200 results.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `pattern` | string | Glob (matched against the entry name) or RE2 regex (matched anywhere in the name, case-sensitive). See [Pattern syntax](#pattern-syntax) |
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

Files exceeding `max_file_size_kb` (node or hub config, default 100 KB) return `FILE_TOO_LARGE`. Range reads that exceed the cap return `READ_TOO_LARGE` — narrow the range.

---

### `grep_files`

Search file contents for a literal string or regex. Does not match filenames. Results are grouped by file, capped at 50 matches or 100 KB of output, whichever comes first. Files larger than 10 MB are skipped.

**Input**:

| Param | Type | Description |
|---|---|---|
| `share` | string | Path root share |
| `pattern` | string | Literal string, or RE2 regex (matched anywhere in each line, case-sensitive) when `type` is `"regex"`. See [Pattern syntax](#pattern-syntax) |
| `relative_path` | string? | File or directory to search within |
| `file_glob` | string? | Glob to filter files when searching a directory (e.g. `"*.ts"`), matched against file names; same glob rules as [Pattern syntax](#pattern-syntax) |
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

The relay is an OAuth resource server; [asterism](adr/0022-asterism-authorization-server.md) is the authorization server. Every `/api/*` endpoint requires an asterism-issued JWT access token as `Authorization: Bearer <token>`, with audience `<RELAY_URL>/mcp` and the `relay` scope. Every endpoint except `POST /api/executors/register` also requires a token issued to the CLI client (`<RELAY_URL>/clients/cli.json`); a token issued to an MCP client gets `403 invalid_client`. Get one with `constellation relay login`.

Admin-only endpoints (`GET /api/admin/hub-shares`, `GET /api/admin/activity`, and `POST /api/executors/register` with `type: "hub"`) additionally need the `admin` scope in the token. `admin` needs a fresh sign-in: asterism grants it only when a client asks for it with `scope=relay admin`. It covers hub registration, hub-share configuration and the admin activity log. The token's `groups` must also contain the relay's `ADMIN_GROUP` (default `constellation-admins`); without it the relay answers a plain `403`. A token without the scope gets a `403 insufficient_scope` whose `WWW-Authenticate` header asks for `scope="relay admin"`. The CLI does this for you with a second device sign-in; the admin token is not stored.

All error responses follow:
```json
{ "error": "<code>", "error_description": "<human-readable>" }
```

Common auth errors:

| Status | `error` | Meaning |
|---|---|---|
| `401` | `unauthorized` | Bearer token missing. `WWW-Authenticate` carries `resource_metadata` pointing at `/.well-known/oauth-protected-resource/mcp` |
| `401` | `invalid_token` | Token malformed, expired, or wrong issuer or audience. Same `WWW-Authenticate` challenge, with `error="invalid_token"` |
| `403` | `insufficient_scope` | The token lacks the `relay` scope, an admin endpoint was called without `admin`, or registration without `register`. `WWW-Authenticate` names the scopes needed (`relay admin` for admin endpoints, `relay register` for a node, `relay admin register` for a hub) |
| `403` | `invalid_client` | The token was issued to a client other than the CLI (`/api` only; registration checks the node or hub client) |
| `429` | `rate_limit_exceeded` | Authenticated calls are limited per user, failed or unauthenticated ones per IP |
| `503` | `temporarily_unavailable` | The relay could not fetch asterism's signing keys (`jwks_unavailable`). The token was not judged invalid; retry after the `Retry-After` interval (30 seconds) |

List endpoints support pagination via `limit` (default 100, max 1000) and `offset` (default 0) query parameters and return:
```json
{ "data": [...], "total": <n>, "limit": <n>, "offset": <n> }
```

### `GET /api/status`

Process uptime and version. Requires a Bearer token like every other `/api/*` endpoint
— it is not a liveness check (that's `/healthz`, unauthenticated, outside `/api/*`).

**Response `200`**
```json
{ "status": "ok", "uptime_seconds": 3724, "version": "<version>" }
```

---

### `GET /api/me`

Returns the caller's Constellation user ID (the token's `sub`) and the scopes and groups carried by the access token. Useful for checking whether a token holds `admin`.

**Response `200`**
```json
{ "user_id": "...", "scopes": ["relay"], "groups": ["engineering"] }
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
| `pattern` | yes | Glob or regex string (max 1000 characters; regex is RE2, matched anywhere in the absolute path). See [Path Filters](relay.md#path-filters) |
| `pattern_type` | yes | `"glob"` or `"regex"` |
| `executor_id` | no | Scope to a specific executor; omit for all executors |

**Response `201`** — the created filter object.

| Status | Meaning |
|---|---|
| `201` | Filter created |
| `400` | Missing/invalid fields, invalid glob or regex, pattern too long, or the user already has 100 filters |
| `404` | `executor_id` not found for this user |

---

### `DELETE /api/filters/:id`

Remove a path filter.

| Status | Meaning |
|---|---|
| `204` | Deleted |
| `404` | Not found or belongs to another user |

---

### `POST /api/executors/register`

Registers a node or hub and mints its long-lived executor token. It replaces the old device-code registration. The caller sends an asterism access token as a bearer: a node needs the `relay` and `register` scopes, a hub also needs `admin`. `register` requires a fresh sign-in and a consent screen. `constellation node init` and `constellation hub register` call this for you after their device sign-in.

**Request body**

| Field | Required | Description |
|---|---|---|
| `type` | yes | `"node"` or `"hub"` |
| `host` | yes | Host name, trimmed, at most 63 characters |

**Response `200`**
```json
{ "access_token": "...", "token_type": "agent", "host": "nas-shared" }
```

`access_token` is the executor token used on `/executor/connect`. It is returned once and not stored. Registering the same host again revokes the previous token (for a hub, the previous active hub token for that host).

| Status | Meaning |
|---|---|
| `200` | Registered |
| `400` | `type` is not `node` or `hub`, or `host` is missing or too long |
| `401` / `403` | Missing or invalid token; a missing `register` scope (or `admin` for a hub) returns `403 insufficient_scope` |

---

### `GET /api/activity`

Activity log for the authenticated user. Returns tool calls, errors, rate limit hits, and executor connection events, newest first.

**Query params**

| Param | Description |
|---|---|
| `event_type` | Filter to one event type (optional). See table below. Returns `400` for unrecognised values. |
| `limit` | Default 100, max 1000 |
| `offset` | Default 0 |

**Response `200`**
```json
{
  "data": [
    {
      "id": 42,
      "event_type": "tool_call",
      "host": "home-server",
      "tool": "read_file",
      "share": "projects",
      "request_id": "a3f9c2e1d4b85f2a...",
      "duration_ms": 84,
      "error_code": null,
      "error_message": null,
      "created_at": "2026-05-27T20:00:00.000Z"
    }
  ],
  "total": 142,
  "limit": 100,
  "offset": 0
}
```

**Event types**

| `event_type` | Populated fields | Description |
|---|---|---|
| `tool_call` | `host`, `tool`, `share`, `request_id`, `duration_ms`; `error_code` + `error_message` when the executor returned an error | RPC reached the executor and a response was received |
| `tool_error` | `host`, `tool`, `share`, `request_id`, `error_code` | RPC could not be delivered: `executor_offline`, `executor_disconnected`, or `timeout` |
| `rate_limited` | `tool`, `share`, `request_id` | Call rejected before dispatch — per-user rate limit exceeded. Written at most once per user per minute |
| `executor_connect` | `host` | Executor opened a WebSocket connection |
| `executor_disconnect` | `host`; `error_code` (`timeout` or `error`) for non-clean disconnects | Executor connection closed |

The `request_id` on `tool_call`, `tool_error`, and `rate_limited` events matches the `request_id` field in the relay's structured log output, allowing activity entries to be correlated with log lines.

The log is capped at `ACTIVITY_LOG_MAX_ENTRIES` rows per user (default 1000). Oldest rows are pruned every 5 minutes.

---

### `GET /api/admin/activity`

Activity log entries with no associated user — `executor_connect`/`executor_disconnect` events for **hubs**, which aren't bound to any single user. Admins collectively own this data, since no individual user does. Newest first.

Accepts the same `event_type`, `limit`, and `offset` query params, and returns the same response shape, as `GET /api/activity`. Entries are capped and pruned the same way, as their own ring buffer (`user_id IS NULL` rows are partitioned together by `ACTIVITY_LOG_MAX_ENTRIES`).

---

### `GET /api/admin/hub-shares`

List all hub shares synced to the relay from hubs. Requires the `admin` scope.

**Query params**: `executor_id` — filter to a specific hub by ID (optional).

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
        "default": "read-only",
        "overrides": [{ "sub": "user-id-abc", "access": "read-write" }, { "group": "engineering", "access": "read-only" }]
      },
      "updated_at": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

## Discovery and client metadata

These are unauthenticated, cacheable `GET` endpoints outside `/api/*`. The relay serves no `/oauth/*`, `/activate*`, `/setup`, `/auth/*` or `/.well-known/oauth-authorization-server`; sign-in, accounts and revocation (`/grants`) are asterism's.

### `GET /.well-known/oauth-protected-resource/mcp`

RFC 9728 protected resource metadata. Names asterism (`ASTERISM_ISSUER`) as the authorization server for the resource `<RELAY_URL>/mcp`, and lists the `relay` scope. The `admin` scope is step-up only and is deliberately not in `scopes_supported`. Every `401` from `/mcp` and `/api` points here through `resource_metadata` in `WWW-Authenticate`.

### `GET /clients/cli.json` · `GET /clients/node.json` · `GET /clients/hub.json`

OAuth Client ID Metadata Documents for the CLI, node and hub. Each document's `client_id` is the URL it is served from (`<RELAY_URL>/clients/<kind>.json`); asterism fetches it when the client first asks for a device code. They are separate clients so that revoking one grant in asterism does not end the others. The documents declare `token_endpoint_auth_method: "none"` and the authorization code, device code and refresh token grant types.
