# Configuration

- [Broker — Environment Variables](#broker--environment-variables)
- [Docker Compose Variables](#docker-compose-variables)
- [Agent — Config Files](#agent--config-files)
- [Agent — Environment Variables](#agent--environment-variables)
- [CLI Flags](#cli-flags)

---

## Broker — Environment Variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/constellation`) |
| `BROKER_URL` | Public base URL of the broker, no trailing slash (e.g. `https://broker.example.com`). Used to construct OAuth callback URLs and the discovery document — must be the URL MCP clients and browsers can reach. |
| `TRUST_PROXY` | Comma-separated list of trusted reverse proxy IP addresses or CIDR ranges. Required unless `TRUST_PROXY_PRESET` is set. Must not be a number or boolean — use explicit IPs/CIDRs. Example: `127.0.0.1` |
| `TRUST_PROXY_PRESET` | Shorthand alternative to `TRUST_PROXY`. Accepted values: `railway`, `fly`, `cloudflare-tunnel`. Overrides `TRUST_PROXY` if both are set. |

Exactly one of `TRUST_PROXY` or `TRUST_PROXY_PRESET` must be set. The broker refuses to start if both are absent.

### Auth mode

`AUTH_MODE` controls how users authenticate. Defaults to `oidc`.

| Value | Behaviour |
|---|---|
| `oidc` (default) | Delegates authentication to an upstream OIDC provider. Requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`. User management endpoints return `404`. |
| `local` | Built-in username/password auth. No OIDC provider required. First-run setup wizard creates the admin account. User management available via `constellation broker users` and `GET/POST /api/users`. |

**OIDC variables** (required when `AUTH_MODE=oidc`):

| Variable | Description |
|---|---|
| `OIDC_ISSUER` | OIDC provider issuer URL (e.g. `https://accounts.google.com`, `https://login.microsoftonline.com/<tenant>/v2.0`) |
| `OIDC_CLIENT_ID` | Client ID from your OIDC provider |
| `OIDC_CLIENT_SECRET` | Client secret from your OIDC provider |

Register an OAuth application with your provider and add these redirect URIs:
- `https://your-broker.example.com/oauth/callback` — MCP clients (Claude, Cursor)
- `https://your-broker.example.com/activate/callback` — agent and broker CLI device flows

The broker constructs both callback URLs from `BROKER_URL` automatically — there is no separate callback URL variable.

**Google** — set `OIDC_ISSUER=https://accounts.google.com`. Create a Web application credential in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and add both redirect URIs above.

**Azure AD** — set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`. Register an application in [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) and add both redirect URIs under **Authentication**.

**Authentik** — set `OIDC_ISSUER=https://your-authentik.example.com/application/o/<slug>/`. Create an OAuth2/OpenID Provider in Authentik and add both redirect URIs.

### Optional

**Server**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server binds to |
| `NODE_ENV` | — | Set to `production` to enable `Secure` flag on cookies |
| `ALLOWED_ORIGINS` | — | Comma-separated list of origins allowed to make cross-origin requests (e.g. `https://claude.ai,https://cursor.com`). Required for browser-based MCP clients. Defaults to no cross-origin access if unset. |
| `LOG_LEVEL` | `warn` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

**OAuth token lifetimes**

| Variable | Default | Description |
|---|---|---|
| `OAUTH_ACCESS_TOKEN_TTL_HOURS` | `24` | Lifetime of MCP client access tokens, in hours |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | Lifetime of MCP client refresh tokens, in days |
| `OAUTH_DYNAMIC_CLIENT_TTL_HOURS` | `24` | How long a dynamically registered OAuth client may sit unactivated (no completed auth flow) before it's pruned |

**Timeouts and heartbeat**

| Variable | Default | Description |
|---|---|---|
| `RPC_TIMEOUT_MS` | `30000` | Maximum wait for an agent to respond to a tool call, in milliseconds |
| `HEARTBEAT_INTERVAL_SECONDS` | `60` | How often the broker pings each connected agent |
| `HEARTBEAT_MAX_MISSED` | `3` | Consecutive missed pongs before the agent connection is terminated |
| `WS_MAX_MESSAGE_BYTES` | `10485760` | Maximum WebSocket message size the broker will accept from an agent, in bytes (default 10 MB) |

An agent is considered **online** when `now − last_heartbeat_at < HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED × 1000 ms`.

**Rate limits**

All numeric variables are validated at startup. A non-integer value causes the broker to exit with an error naming the offending variable.

| Variable | Default | Window | Denominator | Description |
|---|---|---|---|---|
| `RATE_LIMIT_TOOL_CALLS_PER_MIN` | `60` | 60 s | Per user | Standard MCP tool call limit |
| `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN` | `20` | 60 s | Per user | Limit for `grep_files`, `find_files`, and recursive `list_directory` |
| `RATE_LIMIT_OAUTH_PER_15MIN` | `10` | 15 min | Per IP | Requests to `/oauth/token`, `/oauth/register`, `/oauth/device/code`, `/setup`, `/auth/login` |
| `RATE_LIMIT_DEVICE_POLL_PER_15MIN` | `200` | 15 min | Per IP | Requests to `/oauth/token` with `grant_type=device_code`. Device clients poll every 5 s for up to 15 min (≈180 requests); this must exceed that. |
| `RATE_LIMIT_WS_RECONNECT_PER_MIN` | `10` | 60 s | Per agent token | Agent WebSocket reconnect attempts |

Rate limit state is in-memory. It is lost on broker restart, which is acceptable for single-instance deployments.

**Activity log**

| Variable | Default | Description |
|---|---|---|
| `ACTIVITY_LOG_MAX_ENTRIES` | `1000` | Maximum activity log entries retained per user. Oldest rows are pruned every 5 minutes. |
| `ACTIVITY_SINK_POSTGRES` | `true` | Write events to the `activity_logs` table. Set to `false` to disable. |
| `ACTIVITY_SINK_STDOUT` | `false` | Emit each event as a newline-delimited JSON line to stdout. Useful for log aggregators that scrape stdout (e.g. Loki, Datadog agent). |
| `ACTIVITY_SINK_WEBHOOK_URL` | — | HTTP endpoint to POST each event to as JSON (`Content-Type: application/json`). Failures are logged as warnings and do not affect the tool call. |

Multiple sinks can be active simultaneously. Set `ACTIVITY_SINK_POSTGRES=false` and configure a webhook or stdout sink to route events exclusively to an external system.

---

## Docker Compose Variables

These are consumed by the Postgres container in Docker Compose deployments (not by the broker process itself). `DATABASE_URL` must use matching credentials.

| Variable | Description |
|---|---|
| `POSTGRES_USER` | Postgres username |
| `POSTGRES_PASSWORD` | Postgres password |
| `POSTGRES_DB` | Postgres database name |

The Cloudflare Tunnel deployment additionally requires:

| Variable | Description |
|---|---|
| `CLOUDFLARE_TUNNEL_TOKEN` | Token from the Cloudflare Zero Trust dashboard (Networks → Tunnels → your tunnel → Install connector) |

---

## Reverse Proxy (standard deployment)

The standard Docker Compose deployment (`docker/standard/`) exposes the broker on port 3000. Put a reverse proxy in front to terminate TLS.

Example Caddyfile — Caddy obtains and renews a TLS certificate automatically:

```
your-broker.example.com {
    reverse_proxy localhost:3000
}
```

Set `TRUST_PROXY=127.0.0.1` in your `.env` when running behind a local reverse proxy. The Cloudflare Tunnel deployment does not need a reverse proxy — see [self-hosted-cloudflare-tunnel.md](self-hosted-cloudflare-tunnel.md).

---

## Agent — Config Files

Config files live in the platform-default directory unless overridden.

| Platform | Default path |
|---|---|
| Linux / macOS | `~/.config/constellation/` |
| Windows | `%APPDATA%\constellation\` |

Set restrictive permissions on both files:
```sh
chmod 600 ~/.config/constellation/agent.yaml
chmod 600 ~/.config/constellation/paths.yaml
```

### `agent.yaml`

Written by `constellation agent init`. Do not edit `agent_token` by hand.

```yaml
broker_url: https://your-broker.example.com
agent_token: <managed automatically>
host: home-server
max_file_size_kb: 100
```

| Field | Required | Description |
|---|---|---|
| `broker_url` | yes | Full HTTPS URL of the broker, no trailing slash |
| `agent_token` | yes | Bearer token used to authenticate the WebSocket connection. Managed by `constellation agent init` and `constellation agent rotate`. |
| `host` | yes | Display name for this machine. Must be unique across all agents on your account. |
| `max_file_size_kb` | no | Maximum KB the agent will return in a single `read_file` call. Default: `100`. Range reads (`start_line`/`end_line`) are subject to the same cap per call. |

### `paths.yaml`

Managed by `constellation agent paths add/remove`, or edited manually followed by `constellation agent sync`.

```yaml
paths:
  - label: projects
    path: /home/user/projects
  - label: dotfiles
    path: /home/user/.config
```

| Field | Description |
|---|---|
| `label` | Unique name for this path across all agents on your account. Used as the routing key in MCP tool calls. |
| `path` | Absolute path that exists on this machine. |

Labels must be unique per account — two agents on the same account cannot share a label name.

### `broker-session.yaml`

Written by `constellation broker login`. Stores the management API session used by `constellation broker *` commands. Not used by the agent daemon.

```yaml
broker_url: https://your-broker.example.com
access_token: <secret>
access_token_expires_at: "2026-06-25T10:00:00.000Z"
refresh_token: <secret>
refresh_token_expires_at: "2026-07-25T10:00:00.000Z"
```

The CLI silently refreshes the access token on expiry if a refresh token is present. If the refresh token also expires, re-run `constellation broker login`. `refresh_token` and `refresh_token_expires_at` are omitted if the broker did not issue a refresh token.

---

## Agent — Environment Variables

| Variable | Description |
|---|---|
| `CONSTELLATION_CONFIG_DIR` | Override the config directory. Equivalent to passing `--config <dir>` to every command. |
| `LOG_LEVEL` | Agent daemon log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `warn`. Set in the service environment for verbose output. |

---

## CLI Flags

### Global — `constellation [flags] <command>`

| Flag | Description |
|---|---|
| `--config <dir>` | Override the config directory for this invocation. Also respected as `CONSTELLATION_CONFIG_DIR`. |

### `constellation agent` commands

| Flag | Commands | Description |
|---|---|---|
| `--broker <url>` | `init` | Broker URL to register with. Overrides any existing `broker_url` in config. |
| `--foreground` | `start` | Run the daemon directly in the current process instead of via the service manager. Used internally by the service unit. |
| `--json` | `status`, `paths list` | Emit machine-readable JSON output instead of human-readable text. |
| `-f` | `logs` | Follow (tail) the log stream. |
| `--lines <n>` | `logs` | Number of log lines to show. Default: `50`. |

### `constellation broker` commands

| Flag | Commands | Description |
|---|---|---|
| `--broker <url>` | `login` | Broker URL to authenticate against. Defaults to `broker_url` from `agent.yaml`. |
| `--json` | `agents list`, `labels list`, `filters list`, `sessions list`, `users list` | Emit machine-readable JSON output. |
| `--agent <id>` | `labels list`, `filters add` | Filter results or scope a filter to a specific agent ID. |
| `--type glob\|regex` | `filters add` | Pattern type for a new deny filter. Default: `glob`. |
