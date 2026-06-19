# Constellation Relay

The relay component of [Constellation](https://github.com/Mahasamuha/constellation-mcp) — a self-hosted MCP file server that lets MCP clients (Claude, ChatGPT, Cursor) access the filesystems of your machines through a central relay.

```
MCP client → relay (VPS / Railway / Fly) → node (your machine)
```

Nodes connect outbound to the relay over WebSocket — no inbound ports required on the machines you expose. The relay handles OAuth 2.0 authentication for MCP clients and routes tool calls to the appropriate node.

## Quick Start

```yaml
services:
  relay:
    image: mahasamuha/constellation-relay
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/constellation
      RELAY_URL: https://your-relay.example.com
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
| `RELAY_URL` | Public base URL of the relay, no trailing slash (e.g. `https://relay.example.com`) — used to construct OAuth callback URLs |
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
| `PORT` | `3000` | TCP port the relay binds to |
| `TRUST_PROXY_PRESET` | — | Shorthand for `TRUST_PROXY`: `railway`, `fly`, or `cloudflare-tunnel` |
| `RPC_TIMEOUT_MS` | `30000` | Max wait for a node response, in milliseconds |
| `LOG_LEVEL` | `warn` | Pino log level: `trace` … `fatal` |
| `OAUTH_ACCESS_TOKEN_TTL_HOURS` | `24` | MCP client access token lifetime |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | MCP client refresh token lifetime |

Full variable reference: [docs/configuration.md](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/configuration.md)

## First Run

Database migrations apply automatically on every start. On first visit the relay runs a setup wizard to create your admin account (when `AUTH_MODE=local`).

## Node Setup

Install the `constellation` node on each machine you want to expose:

```sh
constellation node init --relay https://your-relay.example.com
constellation node paths add projects /home/user/projects
constellation node install && constellation node start
```

Node binaries for Linux, macOS, and Windows are on [GitHub Releases](https://github.com/Mahasamuha/constellation-mcp/releases/latest).

## MCP Client Setup

Add the relay URL to your MCP client — clients that support OAuth discovery (Claude, ChatGPT, Cursor) authenticate automatically on first connection.

| Client | Config |
|---|---|
| Claude | Settings → Integrations → add `https://your-relay.example.com/mcp` |
| ChatGPT | Settings → Apps & Connectors → Add new connector (Pro/Team/Enterprise/Edu only) |
| Cursor | `.cursor/mcp.json`: `{ "mcpServers": { "constellation": { "url": "https://..." } } }` |

## Documentation

- [Architecture overview](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/architecture.md)
- [Configuration reference](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/configuration.md)
- [Relay API reference](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/relay.md)
- [Self-hosted with Cloudflare Tunnel](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/self-hosted-cloudflare-tunnel.md)

## License

[PolyForm Noncommercial License 1.0.0](https://github.com/Mahasamuha/constellation-mcp/blob/main/LICENSE) — free for personal and noncommercial use. Commercial use requires a separate license.
