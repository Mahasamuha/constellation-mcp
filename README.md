<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/constellation-logo-dark.svg">
  <img src="assets/logo/constellation-logo.svg" alt="Constellation" width="400">
</picture>

# Constellation

Access any machine's filesystem from any MCP client (Claude, ChatGPT, Cursor) through a self-hosted relay — no inbound ports required on the machines you expose.

[![CI / Tests](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml)
[![CI / Build](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml)
[![Docker Image](https://img.shields.io/docker/v/mahasamuha/constellation-relay?label=docker&logo=docker)](https://hub.docker.com/r/mahasamuha/constellation-relay)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](./LICENSE)

## How It Works

1. **Stand up the relay** — a small self-hosted server that relays between your MCP client and your machines.
2. **Install the node** on each machine you want to expose. The node connects outbound to the relay, so no inbound ports are needed on the machine itself.
3. **Add paths** on the node — each path scopes what the MCP client can see (e.g. `/home/user/notes`). Paths get a short share name (e.g. `notes`) that makes them easy to reference in conversation.
4. **Connect your MCP client** (Claude, Cursor, etc.) to the relay URL — it sees one unified tool surface across all your nodes and their registered shares.

That's it. Ask your AI assistant to read, search, or edit anything under a registered path, on any connected machine.

## Prerequisites

- Docker and Docker Compose (relay)
- A publicly accessible address (domain or IP) for the relay — required for node and MCP client connectivity

## Installation

### Server (relay)

```bash
# Standard deployment (relay + Postgres, port 3000 exposed — add a reverse proxy for TLS)
cd docker/standard
cp .env.example .env
# Edit .env — set RELAY_URL, AUTH_MODE, and any auth variables
docker compose up -d
```

Alternatively, use [`docker/cloudflare-tunnel/`](docker/cloudflare-tunnel/) for a no-open-ports setup via Cloudflare Tunnel, or deploy to Railway — see [Quick Start](#quick-start) below.

On first visit the relay runs a setup wizard to create your admin account. Migrations apply automatically on every start.

### Client (node)

Download the latest release from [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest) and install it on each machine you want to expose.

| Platform | File | Install |
|---|---|---|
| Linux | `constellation-node_*_amd64.deb` | `sudo dpkg -i constellation-node_*_amd64.deb` |
| macOS | `constellation-node_*_macos-arm64.tar.gz` | Extract, then `sudo mv constellation /usr/local/bin/` |
| Windows | `constellation-node_*_windows-x64.zip` | Extract and add to `PATH` |

A system tray GUI is also available for desktop machines — see [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest).

## Quick Start

The fastest path is Railway: deploy a relay with one click, install the node binary on your machines, and add the relay URL to your MCP client. No DNS, no reverse proxy, no OIDC provider.

```bash
# 1. Deploy relay to Railway
#    - Create a new Empty Project at railway.com
#    - Add this repo as a GitHub service and add a PostgreSQL database
#    - Set these variables in the relay service:
#        AUTH_MODE=local
#        TRUST_PROXY_PRESET=railway
#        DATABASE_URL=${{Postgres.DATABASE_URL}}
#        RELAY_URL=https://<your-app>.up.railway.app
#    - Generate a public domain under Settings → Networking
#    - Deploy — railway.toml is detected automatically

# 2. Visit the relay URL and complete the setup wizard to create your admin account
#    https://<your-app>.up.railway.app

# 3. Initialize the node on each machine you want to expose
constellation node init --relay https://<your-app>.up.railway.app
constellation node paths add projects /home/user/projects
constellation node install && constellation node start

# 4. Add the relay to your MCP client
#    Claude: Settings → Integrations → add URL
#    Cursor: .cursor/mcp.json
{ "mcpServers": { "constellation": { "url": "https://<your-app>.up.railway.app/mcp" } } }
```

For self-hosted options see [Self-hosted with Cloudflare Tunnel](docs/self-hosted-cloudflare-tunnel.md).

To expose a shared multi-user machine (NAS, dev server, domain host) see [Hub Quick Start](HUB_QUICKSTART.md).

## Configuration

### Server (relay)

| Variable | Description | Default |
|---|---|---|
| `RELAY_URL` | Public base URL of the relay, no trailing slash | — |
| `AUTH_MODE` | `local` (built-in username/password) or `oidc` (external provider) | `local` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `TRUST_PROXY` | Trusted reverse proxy IPs/CIDRs (e.g. `127.0.0.1`) | — |
| `TRUST_PROXY_PRESET` | Shorthand: `railway`, `fly`, or `cloudflare-tunnel` (overrides `TRUST_PROXY`) | — |
| `OIDC_ISSUER` | OIDC provider issuer URL — required when `AUTH_MODE=oidc` | — |
| `OIDC_CLIENT_ID` | OIDC client ID — required when `AUTH_MODE=oidc` | — |
| `OIDC_CLIENT_SECRET` | OIDC client secret — required when `AUTH_MODE=oidc` | — |
| `OIDC_CALLBACK_URL` | Full URL of `/oauth/callback` — required when `AUTH_MODE=oidc` | — |
| `PORT` | TCP port the HTTP server binds to | `3000` |
| `RPC_TIMEOUT_MS` | Max wait for a node to respond to a tool call | `30000` |

Full variable reference: [docs/configuration.md](docs/configuration.md).

### Client (node)

| Variable / Flag | Description | Default |
|---|---|---|
| `--config <dir>` / `CONSTELLATION_CONFIG_DIR` | Override the config directory | Platform default |
| `max_file_size_kb` (in `node.yaml`) | Max file size for `read_file` calls | `100` |
| `LOG_LEVEL` | Node daemon log verbosity (`trace`…`fatal`) | `warn` |

Full CLI and config reference: [docs/reference.md](docs/reference.md) · [docs/configuration.md](docs/configuration.md).

MCP client setup: [docs/mcp-clients.md](docs/mcp-clients.md).

## Contributing

Open an issue or PR.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license.
