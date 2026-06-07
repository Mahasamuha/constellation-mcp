<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo/constellation-logo-dark.svg">
  <img src="assets/logo/constellation-logo.svg" alt="Constellation" width="400">
</picture>

# Constellation

Access any machine's filesystem from any MCP client (Claude, ChatGPT, Cursor) through a self-hosted broker — no inbound ports required on the machines you expose.

[![CI / Tests](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/ci.yml)
[![CI / Build](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml/badge.svg)](https://github.com/Mahasamuha/constellation-mcp/actions/workflows/build.yml)
[![Docker Image](https://img.shields.io/docker/v/mahasamuha/constellation-broker?label=docker&logo=docker)](https://hub.docker.com/r/mahasamuha/constellation-broker)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](./LICENSE)

## How It Works

1. **Stand up the broker** — a small self-hosted server that acts as a relay between your MCP client and your machines.
2. **Install the agent** on each machine you want to expose. The agent connects outbound to the broker, so no inbound ports are needed on the machine itself.
3. **Add paths** on the agent — each path scopes what the MCP client can see (e.g. `/home/user/notes`). Paths get a short label (e.g. `notes`) that makes them easy to reference in conversation.
4. **Connect your MCP client** (Claude, Cursor, etc.) to the broker URL — it sees one unified tool surface across all your agents and labeled paths.

That's it. Ask your AI assistant to read, search, or edit anything under a registered path, on any connected machine.

## Prerequisites

- Docker and Docker Compose (broker)
- A publicly accessible address (domain or IP) for the broker — required for agent and MCP client connectivity

## Installation

### Server (broker)

```bash
# Standard deployment (broker + Postgres, port 3000 exposed — add a reverse proxy for TLS)
cd docker/standard
cp .env.example .env
# Edit .env — set BROKER_URL, AUTH_MODE, and any auth variables
docker compose up -d
```

Alternatively, use [`docker/cloudflare-tunnel/`](docker/cloudflare-tunnel/) for a no-open-ports setup via Cloudflare Tunnel, or deploy to Railway — see [Quick Start](#quick-start) below.

On first visit the broker runs a setup wizard to create your admin account. Migrations apply automatically on every start.

### Client (agent)

Download the latest release from [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest) and install it on each machine you want to expose.

| Platform | File | Install |
|---|---|---|
| Linux | `constellation-agent_*_amd64.deb` | `sudo dpkg -i constellation-agent_*_amd64.deb` |
| macOS | `constellation-agent_*_macos-arm64.tar.gz` | Extract, then `sudo mv constellation /usr/local/bin/` |
| Windows | `constellation-agent_*_windows-x64.zip` | Extract and add to `PATH` |

A system tray GUI is also available for desktop machines — see [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest).

## Quick Start

The fastest path is Railway: deploy a broker with one click, install the agent binary on your machines, and add the broker URL to your MCP client. No DNS, no reverse proxy, no OIDC provider.

```bash
# 1. Deploy broker to Railway
#    - Create a new Empty Project at railway.com
#    - Add this repo as a GitHub service and add a PostgreSQL database
#    - Set these variables in the broker service:
#        AUTH_MODE=local
#        TRUST_PROXY_PRESET=railway
#        DATABASE_URL=${{Postgres.DATABASE_URL}}
#        BROKER_URL=https://<your-app>.up.railway.app
#    - Generate a public domain under Settings → Networking
#    - Deploy — railway.toml is detected automatically

# 2. Initialize the agent on each machine you want to expose
constellation agent init --broker https://<your-app>.up.railway.app
constellation agent paths add projects /home/user/projects
constellation agent install && constellation agent start

# 3. Add the broker to your MCP client
#    Claude: Settings → Integrations → add URL
#    Cursor: .cursor/mcp.json
{ "mcpServers": { "constellation": { "url": "https://<your-app>.up.railway.app/mcp" } } }
```

For self-hosted options see [Self-hosted with Cloudflare Tunnel](docs/self-hosted-cloudflare-tunnel.md).

To expose a shared multi-user machine (NAS, dev server, domain host) see [Shared Agent Quick Start](SHARED_AGENT_QUICKSTART.md).

## Configuration

### Server (broker)

| Variable | Description | Default |
|---|---|---|
| `BROKER_URL` | Public base URL of the broker, no trailing slash | — |
| `AUTH_MODE` | `local` (built-in username/password) or `oidc` (external provider) | `local` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `TRUST_PROXY` | Trusted reverse proxy IPs/CIDRs (e.g. `127.0.0.1`) | — |
| `TRUST_PROXY_PRESET` | Shorthand: `railway`, `fly`, or `cloudflare-tunnel` (overrides `TRUST_PROXY`) | — |
| `OIDC_ISSUER` | OIDC provider issuer URL — required when `AUTH_MODE=oidc` | — |
| `OIDC_CLIENT_ID` | OIDC client ID — required when `AUTH_MODE=oidc` | — |
| `OIDC_CLIENT_SECRET` | OIDC client secret — required when `AUTH_MODE=oidc` | — |
| `OIDC_CALLBACK_URL` | Full URL of `/oauth/callback` — required when `AUTH_MODE=oidc` | — |
| `PORT` | TCP port the HTTP server binds to | `3000` |
| `RPC_TIMEOUT_MS` | Max wait for an agent to respond to a tool call | `30000` |

Full variable reference: [docs/configuration.md](docs/configuration.md).

### Client (agent)

| Variable / Flag | Description | Default |
|---|---|---|
| `--config <dir>` / `CONSTELLATION_CONFIG_DIR` | Override the config directory | Platform default |
| `max_file_size_kb` (in `agent.yaml`) | Max file size for `read_file` calls | `100` |
| `LOG_LEVEL` | Agent daemon log verbosity (`trace`…`fatal`) | `warn` |

Full CLI and config reference: [docs/reference.md](docs/reference.md) · [docs/configuration.md](docs/configuration.md).

MCP client setup: [docs/mcp-clients.md](docs/mcp-clients.md).

## Contributing

Open an issue or PR.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license.
