# Constellation Broker

The broker component of [Constellation](https://github.com/Mahasamuha/constellation-mcp) — a self-hosted MCP file server that lets MCP clients (Claude, ChatGPT, Cursor) access the filesystems of your machines through a central relay.

```
MCP client → broker (VPS / Railway / Fly) → agent (your machine)
```

Agents connect outbound to the broker over WebSocket — no inbound ports required on the machines you expose. The broker handles OAuth 2.0 authentication for MCP clients and routes tool calls to the appropriate agent.

## Quick Start

```yaml
services:
  broker:
    image: mahasamuha/constellation-broker
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/constellation
      BROKER_URL: https://your-broker.example.com
      AUTH_MODE: local
      TRUST_PROXY: "127.0.0.1"
    depends_on:
      - postgres

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: constellation
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Pre-configured Compose files for standard and Cloudflare Tunnel deployments are in the [GitHub repo](https://github.com/Mahasamuha/constellation-mcp/tree/main/docker).

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `BROKER_URL` | Public base URL of the broker, no trailing slash (e.g. `https://broker.example.com`) — used to construct OAuth callback URLs |
| `TRUST_PROXY` | Trusted reverse proxy IPs/CIDRs (e.g. `127.0.0.1`). Use `TRUST_PROXY_PRESET` instead for Railway, Fly, or Cloudflare Tunnel. |

### Auth Mode

| `AUTH_MODE` | Behaviour |
|---|---|
| `local` (default) | Built-in username/password. A setup wizard creates the admin account on first visit. No external provider required. |
| `oidc` | Delegates to an external OIDC provider (Google, Azure AD, Authentik, or any OIDC-compliant provider). |

**OIDC variables** (required when `AUTH_MODE=oidc`):

| Variable | Description |
|---|---|
| `OIDC_ISSUER` | Issuer URL (e.g. `https://accounts.google.com`) |
| `OIDC_CLIENT_ID` | Client ID from your provider |
| `OIDC_CLIENT_SECRET` | Client secret from your provider |

### Common Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the broker binds to |
| `TRUST_PROXY_PRESET` | — | Shorthand for `TRUST_PROXY`: `railway`, `fly`, or `cloudflare-tunnel` |
| `RPC_TIMEOUT_MS` | `30000` | Max wait for an agent response, in milliseconds |
| `LOG_LEVEL` | `warn` | Pino log level: `trace` … `fatal` |
| `OAUTH_ACCESS_TOKEN_TTL_HOURS` | `24` | MCP client access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | MCP client refresh token lifetime |

Full variable reference: [docs/configuration.md](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/configuration.md)

## First Run

Database migrations apply automatically on every start. On first visit the broker runs a setup wizard to create your admin account (when `AUTH_MODE=local`).

## Agent Setup

Install the `constellation` agent on each machine you want to expose:

```sh
constellation agent init --broker https://your-broker.example.com
constellation agent paths add projects /home/user/projects
constellation agent install && constellation agent start
```

Agent binaries for Linux, macOS, and Windows are on [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest).

## MCP Client Setup

Add the broker URL to your MCP client — clients that support OAuth discovery (Claude, ChatGPT, Cursor) authenticate automatically on first connection.

| Client | Config |
|---|---|
| Claude | Settings → Integrations → add `https://your-broker.example.com/mcp` |
| ChatGPT | Settings → Apps & Connectors → Add new connector (Pro/Team/Enterprise/Edu only) |
| Cursor | `.cursor/mcp.json`: `{ "mcpServers": { "constellation": { "url": "https://..." } } }` |

## Documentation

- [Architecture overview](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/architecture.md)
- [Configuration reference](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/configuration.md)
- [Broker API reference](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/broker.md)
- [Self-hosted with Cloudflare Tunnel](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/self-hosted-cloudflare-tunnel.md)

## License

[PolyForm Noncommercial License 1.0.0](https://github.com/Mahasamuha/constellation-mcp/blob/main/LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license.
