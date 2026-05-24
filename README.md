# Constellation

[![Tests](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml)
[![Build](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml)

A network-accessible MCP file server. Run a local agent on any machine and access its filesystem from any MCP client (Claude, Cursor, GitHub Copilot) through a central broker.

```
MCP client → broker (VPS) → agent (your machine)
```

The agent never opens inbound ports. All traffic flows outbound from the agent to the broker over WebSocket. The broker authenticates MCP clients via OAuth 2.0. The agent is the security boundary — it enforces path restrictions locally regardless of what the broker forwards.

---

## Quick start — Railway (no server required)

Deploy a fully functional broker in minutes with built-in HTTPS, Postgres, and local username/password auth. No DNS, no nginx, no OIDC provider.

1. Go to [railway.com](https://railway.com) and create a new **Empty Project**
2. Click **Create** → **GitHub Repo** and select this repository
3. Add Postgres: click **Create** → **Database** → **Add PostgreSQL**
4. In the broker service **Variables** tab, add:
   ```
   AUTH_MODE=local
   TRUST_PROXY_PRESET=railway
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   BROKER_URL=https://<your-app>.up.railway.app
   ```
   Set `BROKER_URL` after step 5 once you have the domain.
5. Generate a public URL: in the broker service, go to **Settings** → **Networking** → **Generate Domain**. Use that URL as your `BROKER_URL`.
6. Deploy — Railway detects `railway.toml` at the repo root and builds using the broker Dockerfile automatically
7. Open the broker URL — the setup wizard creates your admin account
8. On each machine you want to access, download the agent from [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest) and run:
   ```sh
   constellation agent init --broker https://<your-app>.up.railway.app
   ```
9. Add the broker URL to your MCP client:
   ```json
   { "mcpServers": { "constellation": { "type": "http", "url": "https://<your-app>.up.railway.app/mcp" } } }
   ```

For self-hosted options see [Self-hosted with Cloudflare Tunnel](docs/self-hosted-cloudflare-tunnel.md) or the full self-hosted setup below.

---

## Requirements (self-hosted)

- Docker and Docker Compose (broker)
- A reverse proxy for TLS, **or** a Cloudflare account (free) for the tunnel option

---

## 1. Deploy the broker

### Choose a deployment style

Pick the folder that matches how you want to run the broker. Each has a self-contained `docker-compose.yml` and `.env.example`.

| Folder | What it does |
|---|---|
| [`docker/standard/`](docker/standard/) | Broker + Postgres. Port 3000 exposed — add a reverse proxy (Caddy, nginx) in front for TLS. |
| [`docker/cloudflare-tunnel/`](docker/cloudflare-tunnel/) | Broker + Postgres + Cloudflare Tunnel. No open ports or reverse proxy needed. |

### Configure and start

```sh
# Example: standard deployment
cd docker/standard
cp .env.example .env
# Edit .env — set BROKER_URL and any auth variables
docker compose up -d
```

On first start the broker automatically applies pending database migrations. Subsequent deploys do the same — no manual migration step required.

**For the standard deployment**, add a reverse proxy in front for TLS. Example Caddyfile:

```
your-broker.example.com {
    reverse_proxy localhost:3000
}
```

**For the Cloudflare Tunnel deployment**, see [docs/self-hosted-cloudflare-tunnel.md](docs/self-hosted-cloudflare-tunnel.md) for the full setup walkthrough.

### Environment variables

**`AUTH_MODE=local` (default — no OIDC provider needed)**

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `BROKER_URL` | Public URL of the broker, e.g. `https://your-broker.example.com` |
| `TRUST_PROXY` or `TRUST_PROXY_PRESET` | See the `.env.example` in your chosen deployment folder |

On first visit the setup wizard creates your admin account. Additional users: `constellation broker users add <username>`.

**`AUTH_MODE=oidc` (external provider)**

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `OIDC_ISSUER` | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | Client ID from your OIDC provider |
| `OIDC_CLIENT_SECRET` | Client secret from your OIDC provider |
| `BROKER_URL` | Public URL of the broker, e.g. `https://your-broker.example.com` |

Register an OAuth application with your provider and add these redirect URIs:
- `https://your-broker.example.com/oauth/callback` — MCP clients (Claude, Cursor)
- `https://your-broker.example.com/activate/callback` — agent and broker CLI device flows

**Google:** set `OIDC_ISSUER=https://accounts.google.com` and create a Web application client ID in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

**Azure AD:** set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0` and register an app in [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps).

**Authentik:** set `OIDC_ISSUER=https://your-authentik.example.com/application/o/<slug>/` and create an OAuth2/OpenID Provider.

---

## 2. Install the agent

Download the latest release from [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest). Two options:

### CLI (recommended for servers and headless machines)

| Platform | File | Install |
|---|---|---|
| Linux | `constellation-agent_*_amd64.deb` | `sudo dpkg -i constellation-agent_*_amd64.deb` |
| macOS | `constellation-agent_*_macos-arm64.tar.gz` | Extract, then `sudo mv constellation /usr/local/bin/` |
| Windows | `constellation-agent_*_windows-x64.zip` | Extract and add to `PATH` |

### GUI (desktop machines)

A system tray app that manages the agent. Requires the CLI to also be installed — the GUI locates it from `PATH`.

| Platform | File |
|---|---|
| macOS | `Constellation Agent GUI_*.dmg` |
| Linux | `Constellation Agent GUI_*.AppImage` or `constellation-agent-gui_*.deb` |
| Windows | `Constellation Agent GUI_*.exe` |

### Initialize

Run this on the machine whose filesystem you want to expose:

```sh
constellation agent init --broker https://your-broker.example.com
```

This opens a browser, authenticates you, and writes credentials to `~/.config/constellation/agent.yaml` (Linux/macOS) or `%APPDATA%\constellation\agent.yaml` (Windows).

**Set config file permissions** (Linux/macOS):

```sh
chmod 600 ~/.config/constellation/agent.yaml
chmod 600 ~/.config/constellation/paths.yaml
```

### Configure paths

Add paths with the CLI (syncs to the broker automatically):

```sh
constellation agent paths add projects /home/user/projects
constellation agent paths add dotfiles /home/user/.config
```

Or edit `~/.config/constellation/paths.yaml` directly and push manually:

```sh
constellation agent sync
```

Labels must be unique across all your agents.

### Install as a system service

```sh
constellation agent install
constellation agent start
```

This registers the agent with your OS service manager (systemd on Linux, launchd on macOS, Task Scheduler on Windows) and starts it. The agent connects to the broker and reconnects automatically on restart.

---

## 3. Connect an MCP client

Add the broker as an MCP server in your client. The broker handles OAuth automatically — most clients (Claude, Cursor, Copilot) will open a browser on first connection.

**Claude (claude.ai)**

In Claude settings → Integrations, add:
```
https://your-broker.example.com/mcp
```

**Cursor**

In `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "constellation": {
      "url": "https://your-broker.example.com/mcp"
    }
  }
}
```

**GitHub Copilot**

Add the server URL in your IDE's Copilot MCP settings. Copilot will attempt Dynamic Client Registration automatically.

---

## 4. Using the tools

Once connected, the model can use these tools:

| Tool | What it does |
|---|---|
| `list_hosts` | Show all your registered machines with online status |
| `list_labels` | Show path labels, optionally filtered by host |
| `list_directory` | Browse a directory tree |
| `file_info` | Check file size and type before reading |
| `read_file` | Read a file, with optional line range |
| `grep_files` | Search file contents by literal string or regex |
| `find_files` | Find files by name pattern |
| `write_file` | Write or append to a file |
| `edit_file` | Apply exact-match text substitutions |
| `copy` | Copy a file or directory |
| `move` | Move a file or directory |
| `create_directory` | Create a directory |
| `delete` | Delete a file or directory (prompts for confirmation on directories) |

Example prompts:
- *"What machines do I have connected?"* → `list_hosts`
- *"Show me the structure of my projects directory"* → `list_directory` with `recursive: true`
- *"Find all .env files in projects"* → `find_files`
- *"Fix the bug in src/auth.ts"* → `read_file`, then `edit_file`

---

## 5. Agent CLI reference

```sh
constellation agent init        # First-time setup
constellation agent install     # Register with OS service manager
constellation agent start       # Start the service
constellation agent stop        # Stop the service
constellation agent restart     # Restart the service
constellation agent status      # Show connection state and labels
constellation agent sync        # Push paths.yaml changes to broker (after manual edits)
constellation agent rotate      # Rotate agent token
constellation agent rename <h>  # Update host name
constellation agent logs [-f]   # Show service logs
constellation agent paths list  # List configured labels
constellation agent paths add <label> <path>   # Add label and sync
constellation agent paths remove <label>       # Remove label and sync
```

## 6. Broker CLI reference

```sh
constellation broker login              # Authenticate with broker management API
constellation broker status             # Broker health and version
constellation broker agents list        # All agents with liveness status
constellation broker agents revoke <id> # Revoke an agent token
constellation broker labels list        # All path labels
constellation broker filters list       # Active deny filters
constellation broker filters add <pattern> [--type glob|regex]
constellation broker filters remove <id>
constellation broker sessions list      # Active MCP client sessions
constellation broker sessions revoke <id>
constellation broker account deactivate

# User management (AUTH_MODE=local only)
constellation broker users list
constellation broker users add <username>
constellation broker users remove <username>
constellation broker users reset-password <username>
```
