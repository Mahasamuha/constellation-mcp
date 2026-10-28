# Constellation Relay

The relay component of [Constellation](https://github.com/Mahasamuha/constellation-mcp) — a self-hosted MCP file server that lets MCP clients (Claude, ChatGPT, Cursor) access the filesystems of your machines through a central relay.

```
MCP client → relay (VPS / Railway / Fly) → node (your machine)
```

Nodes connect outbound to the relay over WebSocket — no inbound ports required on the machines you expose. The relay verifies OAuth 2.1 access tokens issued by asterism (an external authorization server) and routes tool calls to the appropriate node.

## Quick Start

```yaml
services:
  relay:
    image: mahasamuha/constellation-relay:2.0.0
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/constellation
      RELAY_URL: https://your-relay.example.com
      ASTERISM_ISSUER: https://auth.example.com
      TRUST_PROXY: "127.0.0.1"
    depends_on:
      - postgres

  postgres:
    image: postgres:16.14
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: replace-with-a-strong-password
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
| `RELAY_URL` | Public base URL of the relay, no trailing slash (e.g. `https://relay.example.com`) — the token audience is this URL plus `/mcp` |
| `TRUST_PROXY` | Trusted reverse proxy IPs/CIDRs (e.g. `127.0.0.1`). Use `TRUST_PROXY_PRESET` instead for Railway, Fly, or Cloudflare Tunnel. |

### Authorization

| Variable | Description |
|---|---|
| `ADMIN_GROUP` | Group an account must be in, besides holding the `admin` scope, to administer the relay (default `constellation-admins`). |
| `ASTERISM_ISSUER` | Issuer URL of your [asterism](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/adr/0022-asterism-authorization-server.md) authorization server (`https:`). asterism handles sign-in and accounts; register the relay in asterism as a resource server. |

### Common Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the relay binds to |
| `TRUST_PROXY_PRESET` | — | Shorthand for `TRUST_PROXY`: `railway`, `fly`, or `cloudflare-tunnel` |
| `RPC_TIMEOUT_MS` | `30000` | Max wait for a node response, in milliseconds |
| `LOG_LEVEL` | `warn` | Pino log level: `trace` … `fatal` |

Full variable reference: [docs/configuration.md](https://github.com/Mahasamuha/constellation-mcp/blob/main/docs/configuration.md)

## First Run

Database migrations apply automatically on every start. Register the relay in asterism as a resource server and add administrators to its `constellation-admins` group; there is no setup wizard.

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
