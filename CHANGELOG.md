# Changelog

## v0.2.4 — 2026-05-25

### Security

- **Broker container no longer runs as root** — the runtime image now drops to the built-in `node` user (uid 1000) before starting the process.
- **Supply chain attestations added to the broker image** — every published image now includes a SLSA Build Provenance attestation and an SBOM attestation, verifiable with `docker buildx imagetools inspect` or `cosign verify-attestation`.

### Bug fixes

- **Agent GUI version sourced from `package.json`** — `tauri.conf.json` now reads the version at build time from the workspace `package.json` rather than duplicating it, preventing version skew between the binary and the metadata.

### Other changes

- ESLint added to CI with project-wide defaults enforced on every pull request.
- Documentation significantly expanded: architecture, configuration, broker API, and CLI reference now live in dedicated files under `docs/`. New additions include a contributing guide, OIDC provider-specific setup examples (Google, Azure AD, Authentik), a reverse proxy setup section, example MCP prompts, and a Docker Hub overview page.

---

## v0.2.0 — 2026-05-25

### Breaking changes

- **`GET /api/users` response format changed** — now returns a paginated envelope `{ data: [...], total, limit, offset }` matching all other list endpoints. The previous format was a bare array. Affects `AUTH_MODE=local` deployments only. The `constellation broker users list` CLI command is updated accordingly.

### Security fixes

- **Invalid numeric environment variables now fail at startup** — previously, setting a rate-limit variable (e.g. `RATE_LIMIT_TOOL_CALLS_PER_MIN`) to a non-integer value would silently disable that limit due to `NaN` comparison. The broker now rejects any non-integer value with a clear startup error.
- **Agent refuses unencrypted connections to remote brokers** — if `broker_url` uses `http://` (which the agent converts to `ws://`) and the hostname is not `localhost`, `127.0.0.1`, or `::1`, the agent logs an error and refuses to connect. Local development connections over plain HTTP are still permitted.

### Reliability fixes

- **Graceful shutdown sequence corrected** — the broker previously called `closeAllConnections()` before closing the WebSocket hub, which could abruptly kill agent connections and reject in-flight RPC calls. The shutdown now drains idle HTTP connections first, then closes the hub gracefully before stopping the server.
- **Token rotation race condition resolved** — two concurrent WebSocket reconnects with the same new token could both attempt to complete the rotation transaction. The second concurrent connection now detects the rotation is already done and proceeds as a normal reconnect.
- **Agent receives error acknowledgement on internal broker errors** — if a Prisma error occurred while processing a `config_update` or `update_host` message, the agent would wait indefinitely for an acknowledgement that never arrived. The broker now sends a typed error response in these cases.

### Other changes

- All numeric environment variables (`RATE_LIMIT_*`, `HEARTBEAT_*`, `RPC_TIMEOUT_MS`, `WS_MAX_MESSAGE_BYTES`, `PORT`) are now parsed once at startup from a central `config.ts` module rather than on each request.
- Broker filter patterns are now capped at 1000 characters. Patterns exceeding this limit return `400 invalid_request`.

---

## v0.1.0 — 2026-05-24

A network-accessible MCP file server. Run an agent on any machine and access its filesystem from Claude, Cursor, or GitHub Copilot through a central broker — no inbound ports required.

### Broker

- Central WebSocket relay with OAuth 2.0 authentication for MCP clients
- Two auth modes: `AUTH_MODE=local` (built-in username/password with setup wizard) or `AUTH_MODE=oidc` (Google, Azure AD, Authentik, or any OIDC provider)
- First-run setup wizard — no manual account creation step
- Automatic database migrations on startup (Postgres)
- Path label deny filters (glob and regex) for fine-grained access control
- MCP session management with revocation
- Deploy configs for Railway (one-click), Docker + reverse proxy, and Docker + Cloudflare Tunnel (no open ports)

### Agent CLI (`constellation`)

- Outbound-only WebSocket connection to the broker — no inbound firewall rules needed
- Path label system: expose named directories rather than arbitrary paths
- Auto-sync on `paths add` / `paths remove`
- OS service integration: systemd (Linux), launchd (macOS), Task Scheduler (Windows)
- Device flow authentication (`agent init`) opens a browser for one-time setup
- Token rotation (`agent rotate`)
- Standalone binary installers: `.deb` (Linux), `.tar.gz` (macOS arm64), `.zip` (Windows x64)
- Full CLI for host management, logs, status, and broker administration

### Agent GUI (`Constellation Agent GUI`)

- System tray app for desktop machines (Tauri)
- Live connection status and heartbeat display
- Start / Stop / Restart controls from the tray
- Settings window: broker URL, host rename, file size cap, deregister
- Paths window for managing labels
- OS notifications and auto-launch on login
- Packages: `.dmg` (macOS), `.AppImage` + `.deb` (Linux), `.exe` installer (Windows)
- Transparent tray icons on all platforms with Constellation brand assets

### MCP tools (13 total)

| Tool | Description |
|---|---|
| `list_hosts` | All registered machines with online status |
| `list_labels` | Path labels, optionally filtered by host |
| `list_directory` | Browse a directory tree |
| `file_info` | File size and type before reading |
| `read_file` | Read file with optional line range |
| `grep_files` | Search file contents by literal string or regex |
| `find_files` | Find files by name pattern |
| `write_file` | Write or append to a file |
| `edit_file` | Exact-match text substitutions |
| `copy` | Copy a file or directory |
| `move` | Move a file or directory |
| `create_directory` | Create a directory |
| `delete` | Delete a file or directory |

### Infrastructure

- GitHub Actions CI: test suite (vitest, 13 tools covered) and build matrix across all platforms
- GHCR Docker image for the broker published on push to `main`

### Known limitations

- No web UI for the broker — management is CLI-only
- Agent GUI requires the CLI binary to also be installed separately
