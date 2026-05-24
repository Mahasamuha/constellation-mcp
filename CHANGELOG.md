# Changelog

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
