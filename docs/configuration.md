# Configuration

- [Relay — Environment Variables](#relay--environment-variables)
- [Docker Compose Variables](#docker-compose-variables)
- [Reverse Proxy (standard deployment)](#reverse-proxy-standard-deployment)
- [Node — Config Files](#node--config-files)
- [Node — Environment Variables](#node--environment-variables)
- [CLI Flags](#cli-flags)

---

## Relay — Environment Variables

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (e.g. `postgresql://user:pass@localhost:5432/constellation`) |
| `RELAY_URL` | Public base URL of the relay, no trailing slash (e.g. `https://relay.example.com`). Used to construct OAuth callback URLs and the discovery document — must be the URL MCP clients and browsers can reach. |
| `TRUST_PROXY` | Comma-separated list of trusted reverse proxy IP addresses or CIDR ranges. Required unless `TRUST_PROXY_PRESET` is set. Must not be a number or boolean — use explicit IPs/CIDRs. Example: `127.0.0.1` |
| `TRUST_PROXY_PRESET` | Shorthand alternative to `TRUST_PROXY`. Accepted values: `railway`, `fly`, `cloudflare-tunnel`. Overrides `TRUST_PROXY` if both are set. |

Exactly one of `TRUST_PROXY` or `TRUST_PROXY_PRESET` must be set. The relay refuses to start if both are absent.

### Auth mode

`AUTH_MODE` controls how users authenticate. Defaults to `oidc`.

| Value | Behaviour |
|---|---|
| `oidc` (default) | Delegates authentication to an upstream OIDC provider. Requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`. User management endpoints return `404`. |
| `local` | Built-in username/password auth. No OIDC provider required. First-run setup wizard creates the admin account. User management available via `constellation relay users` and `GET/POST /api/users`. |

**OIDC variables** (required when `AUTH_MODE=oidc`):

| Variable | Description |
|---|---|
| `OIDC_ISSUER` | OIDC provider issuer URL (e.g. `https://accounts.google.com`, `https://login.microsoftonline.com/<tenant>/v2.0`) |
| `OIDC_CLIENT_ID` | Client ID from your OIDC provider |
| `OIDC_CLIENT_SECRET` | Client secret from your OIDC provider |

Register an OAuth application with your provider and add these redirect URIs:
- `https://your-relay.example.com/oauth/callback` — MCP clients (Claude, Cursor)
- `https://your-relay.example.com/activate/callback` — node and relay CLI device flows

The relay constructs both callback URLs from `RELAY_URL` automatically — there is no separate callback URL variable.

**Google** — set `OIDC_ISSUER=https://accounts.google.com`. Create a Web application credential in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and add both redirect URIs above.

**Azure AD** — set `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`. Register an application in [Azure Portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps) and add both redirect URIs under **Authentication**.

**Authentik** — set `OIDC_ISSUER=https://your-authentik.example.com/application/o/<slug>/`. Create an OAuth2/OpenID Provider in Authentik and add both redirect URIs.

### Optional

**Server**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server binds to |
| `NODE_ENV` | — | Set to `production` to enable `Secure` flag on cookies |
| `ALLOWED_ORIGINS` | — | Comma-separated list of origins allowed to make cross-origin requests to the relay (e.g. the URL of a reverse proxy or browser-based tool in front of the relay). Defaults to no cross-origin access if unset. |
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
| `RPC_TIMEOUT_MS` | `30000` | Maximum wait for an executor to respond to a tool call, in milliseconds |
| `HEARTBEAT_INTERVAL_SECONDS` | `60` | How often the relay pings each connected executor |
| `HEARTBEAT_MAX_MISSED` | `3` | Consecutive missed pongs before the executor connection is terminated |
| `WS_MAX_MESSAGE_BYTES` | `10485760` | Maximum WebSocket message size the relay will accept from an executor, in bytes (default 10 MB) |

An executor is considered **online** when `now − last_heartbeat_at < HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED × 1000 ms`.

**Rate limits**

All numeric variables are validated at startup. A non-integer value causes the relay to exit with an error naming the offending variable.

| Variable | Default | Window | Denominator | Description |
|---|---|---|---|---|
| `RATE_LIMIT_TOOL_CALLS_PER_MIN` | `60` | 60 s | Per user | Standard MCP tool call limit |
| `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN` | `20` | 60 s | Per user | Limit for `grep_files`, `find_files`, recursive `list_directory`, **and any MCP tool not explicitly classified as "standard" in `router.ts`'s `classifyTool`** |
| `RATE_LIMIT_OAUTH_PER_15MIN` | `10` | 15 min | Per IP | Requests to `/oauth/token` (non-device-code grants), `/oauth/register`, `/oauth/device/code`, `/setup`, `/auth/login` |
| `RATE_LIMIT_DEVICE_POLL_PER_15MIN` | `200` | 15 min | Per IP | Requests to `/oauth/token` with `grant_type=device_code`. Device clients poll every 5 s for up to 15 min (≈180 requests); this must exceed that. |
| `RATE_LIMIT_DEVICE_AUTH_PER_15MIN` | `20` | 15 min | Per IP | Requests to `/activate`, `/activate/login`, `/activate/callback`, `/activate/confirm` — the device-authorization consent flow |
| `RATE_LIMIT_DEFAULT_PER_15MIN` | `10` | 15 min | Per IP | Catch-all for any HTTP route not explicitly classified in `app.ts`'s `classifyHttpRoute` (e.g. `/api/*`). Deliberately the strictest HTTP bucket — see [architecture.md](architecture.md#rate-limiting). `/healthz` and `/mcp` are explicitly exempt instead of falling here; see that doc for why. |
| `RATE_LIMIT_WS_RECONNECT_PER_MIN` | `10` | 60 s | Per executor token | Executor WebSocket reconnect attempts |

Rate limit state is in-memory. It is lost on relay restart, which is acceptable for single-instance deployments.

**Activity log**

| Variable | Default | Description |
|---|---|---|
| `ACTIVITY_LOG_MAX_ENTRIES` | `1000` | Maximum activity log entries retained per user. Oldest rows are pruned every 5 minutes. |
| `ACTIVITY_SINK_POSTGRES` | `true` | Write events to the `activity_logs` table. Set to `false` to disable. |
| `ACTIVITY_SINK_STDOUT` | `false` | Emit each event as a newline-delimited JSON line to stdout. Useful for log aggregators that scrape stdout (e.g. Loki, Datadog agent). |
| `ACTIVITY_SINK_WEBHOOK_URL` | — | HTTP endpoint to POST each event to as JSON (`Content-Type: application/json`). Failures are logged as warnings and do not affect the tool call. |

Multiple sinks can be active simultaneously. Set `ACTIVITY_SINK_POSTGRES=false` and configure a webhook or stdout sink to route events exclusively to an external system.

**Admin & identity**

| Variable | Default | Description |
|---|---|---|
| `ADMIN_GROUPS` | — | Comma-separated OIDC group names that grant the `ADMIN` role on login. Empty = no group→role mapping; bootstrap the first admin via `RELAY_ADMIN_TOKEN` instead (or directly in `AUTH_MODE=local`, where the setup wizard creates the admin account). |
| `RELAY_ADMIN_TOKEN` | — | Bearer token that unlocks a separate, OAuth-independent route for `constellation relay user promote/demote`. Unset by default, in which case those routes return `404`. Intended for bootstrapping the first admin before `ADMIN_GROUPS` is configured. |
| `ADMIN_SESSION_DURATION` | `3600` (seconds) | Lifetime of the elevated-admin window granted by `constellation relay elevate` (the `agent:escalate` scope). |
| `FORWARDED_CLAIMS` | — | Comma-separated list of OIDC claim names to forward to executors in the RPC envelope's `user_claims` field. Empty = forward every claim captured at login (`lastKnownClaims`, the full ID token minus JWT-internal fields like `iat`/`exp`/`nonce`). Set this to restrict forwarding to specific claims only — useful for data minimization when [hub Tier-1 identity resolution](hub.md) only needs one custom claim. |

---

## Docker Compose Variables

These are consumed by the Postgres container in Docker Compose deployments (not by the relay process itself). `DATABASE_URL` must use matching credentials.

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

The standard Docker Compose deployment (`docker/standard/`) exposes the relay on port 3000. Put a reverse proxy in front to terminate TLS.

Example Caddyfile — Caddy obtains and renews a TLS certificate automatically:

```
your-relay.example.com {
    reverse_proxy localhost:3000
}
```

Set `TRUST_PROXY=127.0.0.1` in your `.env` when running behind a local reverse proxy. The Cloudflare Tunnel deployment does not need a reverse proxy — see [self-hosted-cloudflare-tunnel.md](self-hosted-cloudflare-tunnel.md).

---

## Node — Config Files

Config files live in the platform-default directory unless overridden.

| Platform | Default path |
|---|---|
| Linux / macOS | `~/.config/constellation/` |
| Windows | `%APPDATA%\constellation\` |

Set restrictive permissions on both files:
```sh
chmod 600 ~/.config/constellation/node.yaml
chmod 600 ~/.config/constellation/paths.yaml
```

### `node.yaml`

Written by `constellation node init`. Do not edit `node_token` by hand.

```yaml
relay_url: https://your-relay.example.com
node_token: <managed automatically>
host: home-server
max_file_size_kb: 100
```

| Field | Required | Description |
|---|---|---|
| `relay_url` | yes | Full HTTPS URL of the relay, no trailing slash |
| `node_token` | yes | Bearer token used to authenticate the WebSocket connection. Managed by `constellation node init` and `constellation node rotate`. |
| `host` | yes | Display name for this machine. Must be unique across all nodes on your account. |
| `max_file_size_kb` | no | Maximum KB the node will return in a single `read_file` call. Default: `100`. Range reads (`start_line`/`end_line`) are subject to the same cap per call. |

### `paths.yaml`

Managed by `constellation node paths add/remove`, or edited manually followed by `constellation node sync`.

```yaml
paths:
  - share: projects
    path: /home/user/projects
    instructions: "Active client work — prefer the latest dated subfolder."
  - share: dotfiles
    path: /home/user/.config
    context_file: /home/user/.config/README.md
```

| Field | Description |
|---|---|
| `share` | Unique name for this path across all nodes on your account. Used as the routing key in MCP tool calls. |
| `path` | Absolute path that exists on this machine. |
| `instructions` | Optional. Inline text surfaced to MCP clients as `instructions` on the share (via `list_shares`) — useful for describing the share's purpose or conventions. Takes precedence over `context_file` when both are set. Hard-capped at 500 characters; longer values are dropped (logged as a warning on the node) rather than truncated. **Recommended to stay under 250 characters** — this is meant to give a model light context or framing for the share, not to document it or serve as a heavy instruction set. Can also be set from the node GUI's Paths screen, or via `constellation node paths add --instructions <text>`. |
| `context_file` | Optional. Absolute path to a text/markdown file whose contents are read at sync time and used as `instructions` (subject to the same 500-character hard cap and 250-character recommendation) when no inline `instructions` is set. Not required to live within `path`. If missing or unreadable at sync time, `instructions` is omitted for that sync (logged at info level on the node) rather than causing an error. |

Shares must be unique per account — two nodes on the same account cannot use the same share name.

### `relay-session.yaml`

Written by `constellation relay login`. Stores the management API session used by `constellation relay *` commands. Not used by the node daemon.

```yaml
relay_url: https://your-relay.example.com
access_token: <secret>
access_token_expires_at: "2026-06-25T10:00:00.000Z"
refresh_token: <secret>
refresh_token_expires_at: "2026-07-25T10:00:00.000Z"
```

The CLI silently refreshes the access token on expiry if a refresh token is present. If the refresh token also expires, re-run `constellation relay login`. `refresh_token` and `refresh_token_expires_at` are omitted if the relay did not issue a refresh token.

---

## Node — Environment Variables

| Variable | Description |
|---|---|
| `CONSTELLATION_CONFIG_DIR` | Override the config directory. Equivalent to passing `--config <dir>` to every command. |
| `LOG_LEVEL` | Node daemon log verbosity: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default: `warn`. Set in the service environment for verbose output. |

---

## CLI Flags

There is no truly global flag set on `constellation` itself — `--config-dir` and `--relay` are each declared on the `node` and `relay` subsystem commands, not on the root `constellation` command. They must appear somewhere after `node`/`relay` (not before it); the recommended, always-safe position is right after `node`/`relay` and before the subcommand name (e.g. `constellation relay --config-dir <dir> --relay <url> login`).

### `constellation node` commands

| Flag | Commands | Description |
|---|---|---|
| `--config-dir <dir>` | any `node` subcommand | Override config directory. Also respected as `CONSTELLATION_CONFIG_DIR`. Position right after `node`. |
| `--relay <url>` | `init` | Relay URL to register with. Overrides any existing `relay_url` in config. |
| `--foreground` | `start` | Run the daemon directly in the current process instead of via the service manager. Used internally by the service unit. |
| `--json` | `status`, `paths list` | Emit machine-readable JSON output instead of human-readable text. |
| `-f` | `logs` | Follow (tail) the log stream. |
| `--lines <n>` | `logs` | Number of log lines to show. Default: `50`. |

### `constellation relay` commands

| Flag | Commands | Description |
|---|---|---|
| `--config-dir <dir>` | any `relay` subcommand | Override config directory. Also respected as `CONSTELLATION_CONFIG_DIR`. Position right after `relay`. |
| `--relay <url>` | `login`, `elevate`, `user promote`, `user demote` | Relay URL. Defaults to `relay_url` from `node.yaml` if not given. Position right after `relay`, e.g. `constellation relay --relay <url> login`. All other `relay` subcommands use the relay URL already stored in `relay-session.yaml` from a prior `login` and don't accept this flag. |
| `--admin-token <token>` | `user promote`, `user demote` | Relay admin token. Defaults to the `RELAY_ADMIN_TOKEN` env var. |
| `--json` | `executors list`, `shares list`, `filters list`, `sessions list`, `users list`, `hub-shares list` | Emit machine-readable JSON output. |
| `--executor <id>` | `shares list`, `filters add`, `hub-shares list` | Filter results or scope a filter to a specific executor ID. |
| `--type glob\|regex` | `filters add` | Pattern type for a new deny filter. Default: `glob`. |
