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

On a client that supports the [MCP Apps extension](docs/relay.md#mcp-apps) to the MCP spec (Claude.ai, Claude Desktop, VS Code Insiders, Goose, Postman), just ask to browse a share or open a file — Constellation can render an interactive file browser (directory tree, syntax-highlighted viewer, editor) right inline in the conversation instead of plain text. The file browser is **experimental**: some of its context features, such as telling the model which file you have open, don't work reliably on every client. See [MCP Apps](docs/relay.md#mcp-apps).

## Prerequisites

- Docker and Docker Compose (relay)
- A publicly accessible address (domain or IP) for the relay — required for node and MCP client connectivity
- An [asterism](https://github.com/Mahasamuha/asterism-proxy) authorization server for sign-in, on its own HTTPS hostname. The relay's compose files can run one for you (see below). Connect it to an OIDC identity provider such as Authentik if you need admins, hubs or group-based access: asterism's local accounts carry no groups

## Installation

### Server (relay)

```bash
# Standard deployment (relay + Postgres, port 3000 exposed — add a reverse proxy for TLS)
cd docker/standard
cp .env.example .env
# Edit .env — set RELAY_URL and ASTERISM_ISSUER
# To run asterism here too: uncomment COMPOSE_PROFILES=asterism in .env, then
#   cp asterism.env.example asterism.env   # and fill it in
# asterism listens on 127.0.0.1:4000; route ASTERISM_ISSUER's hostname to it
docker compose up -d
```

Alternatively, use [`docker/cloudflare-tunnel/`](docker/cloudflare-tunnel/) for a no-open-ports setup via Cloudflare Tunnel, or deploy to Railway — see [Quick Start](#quick-start) below.

Register the relay in [asterism](https://github.com/Mahasamuha/asterism-proxy) as a resource server; asterism handles sign-in and accounts. See [Running asterism](docs/configuration.md#running-asterism) and the [operator runbook](docs/configuration.md#operator-runbook-configure-asterism-before-users-connect). Migrations apply automatically on every start.

### Client (node)

Download the latest release from [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest) and install it on each machine you want to expose.

| Platform | File | Install |
|---|---|---|
| Linux | `constellation-cli_*_amd64.deb` | `sudo dpkg -i constellation-cli_*_amd64.deb` |
| macOS | `constellation-cli_*_macos-arm64.tar.gz` | Extract, then `sudo mv constellation /usr/local/bin/` |
| Windows | `constellation-cli_*_windows-x64.zip` | Extract and add to `PATH` |

A system tray GUI is also available for desktop machines — see [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest).

## Quick Start

The fastest path is Railway: deploy a relay with one click, install the node binary on your machines, and add the relay URL to your MCP client. No DNS and no reverse proxy; you need an [asterism](https://github.com/Mahasamuha/asterism-proxy) instance for sign-in, hosted separately (for example with its Docker image, `mahasamuha/asterism-proxy`).

```bash
# 1. Deploy relay to Railway
#    - Create a new Empty Project at railway.com
#    - Add this repo as a GitHub service and add a PostgreSQL database
#    - Set these variables in the relay service:
#        ASTERISM_ISSUER=https://<your-asterism>
#        TRUST_PROXY_PRESET=railway
#        DATABASE_URL=${{Postgres.DATABASE_URL}}
#        RELAY_URL=https://<your-app>.up.railway.app
#    - Generate a public domain under Settings → Networking
#    - Deploy — railway.toml is detected automatically

# 2. In asterism, register the relay as a resource server, release the groups, email
#    and constellation_username claims, and restrict the admin scope to the
#    constellation-admins group. Add admins to that group in your identity
#    provider. See docs/configuration.md.

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

Running self-hosted in production? See [docs/operations.md](docs/operations.md) for backup, restore, and upgrade guidance.

## Configuration

### Server (relay)

| Variable | Description | Default |
|---|---|---|
| `RELAY_URL` | Public base URL of the relay, no trailing slash | — |
| `ASTERISM_ISSUER` | Issuer URL of the [asterism](https://github.com/Mahasamuha/asterism-proxy) authorization server (`https:`) | — |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `TRUST_PROXY` | Trusted reverse proxy IPs/CIDRs (e.g. `127.0.0.1`) | — |
| `TRUST_PROXY_PRESET` | Shorthand: `railway`, `fly`, or `cloudflare-tunnel` (overrides `TRUST_PROXY`) | — |
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
