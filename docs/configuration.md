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
| `RELAY_URL` | Public origin of the relay — scheme and host (and port, if non-default) only; no path or trailing slash (e.g. `https://relay.example.com`). The relay refuses to start otherwise: a trailing slash, uppercase host, or explicit default port (e.g. `:443`) all fail the check. Used to construct the discovery and client metadata documents, and it sets the token audience (`${RELAY_URL}/mcp`) — must be the URL MCP clients can reach. Sub-path deployments are not supported. |
| `ASTERISM_ISSUER` | Issuer URL of the [asterism](adr/0022-asterism-authorization-server.md) authorization server, exactly as asterism publishes it. Must be `https:` (`http:` is accepted on a loopback host for development). Access tokens must carry this `iss`. The relay refuses to start if it is unset or invalid. |
| `TRUST_PROXY` | Comma-separated list of trusted reverse proxy IP addresses or CIDR ranges. Required unless `TRUST_PROXY_PRESET` is set. Must not be a number or boolean — use explicit IPs/CIDRs. Example: `127.0.0.1` |
| `TRUST_PROXY_PRESET` | Shorthand alternative to `TRUST_PROXY`. Accepted values: `railway`, `fly`, `cloudflare-tunnel`. Overrides `TRUST_PROXY` if both are set. |

Exactly one of `TRUST_PROXY` or `TRUST_PROXY_PRESET` must be set. The relay refuses to start if both are absent.

### Authorization (asterism)

The relay is an OAuth resource server. [asterism](adr/0022-asterism-authorization-server.md) is the authorization server: it owns sign-in, local accounts, groups, consent, grants and revocation, and it issues the JWT access tokens the relay verifies. There is no `AUTH_MODE`, no OIDC client configuration and no setup wizard in the relay.

To connect a relay to asterism:

1. Set `ASTERISM_ISSUER` and `RELAY_URL` on the relay.
2. Register the relay in asterism as a resource server. asterism fetches the relay's RFC 9728 metadata at `${RELAY_URL}/.well-known/oauth-protected-resource/mcp`, which declares the `relay` scope and the step-up-only `admin` scope. The token audience is `${RELAY_URL}/mcp`.
3. Create the `constellation-admins` group in asterism and add the people who should administer the relay.

**Admin** means the access token holds the `admin` scope. asterism issues that scope only to members of the `constellation-admins` group, and only on step-up (a `403 insufficient_scope` from the relay). It gates `POST /api/tokens/shared`, `GET /api/admin/hub-shares` and `GET /api/admin/activity`. There is no stored role and no admin bootstrap token.

Sign-in, local accounts, user management, password resets and session revocation are done in asterism (its `/grants` page lists and revokes what each client may do). The relay creates a `users` row the first time it sees a token's `sub`.

### Optional

**Server**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server binds to |
| `NODE_ENV` | — | Passed to Express and Node.js internals (e.g. disables verbose error details in production). The `Strict-Transport-Security` header is sent unless `RELAY_URL` is `http://`. |
| `ALLOWED_ORIGINS` | — | Comma-separated list of origins allowed to make cross-origin requests to the relay (e.g. the URL of a reverse proxy or browser-based tool in front of the relay). Defaults to no cross-origin access if unset. |
| `LOG_LEVEL` | `warn` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

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
| `RATE_LIMIT_STATIC_PER_15MIN` | `300` | 15 min | Per IP | The unauthenticated, cheap GETs: `/.well-known/oauth-protected-resource/*` and `/clients/*.json` |
| `RATE_LIMIT_DEFAULT_PER_15MIN` | `10` | 15 min | Per IP | Catch-all for any HTTP route not explicitly classified in `app.ts`'s `classifyHttpRoute` (e.g. `/api/*`, `/`). Deliberately the strictest HTTP bucket — see [architecture.md](architecture.md#rate-limiting). `/healthz` and `/mcp` are explicitly exempt instead of falling here; see that doc for why. |
| `RATE_LIMIT_WS_RECONNECT_PER_MIN` | `10` | 60 s | Per executor token | Executor WebSocket reconnect attempts |

Rate limit state is in-memory. It is lost on relay restart, which is acceptable for single-instance deployments.

> **Multi-user deployments:** the built-in limiter is meant for single-user deployments, prototyping and pilots. Put a multi-user production deployment behind a WAF or an equivalent dedicated rate-limiting and abuse-protection tool. The defaults are sized for one user. Users behind a shared NAT or VPN, and hosted MCP clients whose servers make requests on behalf of many users, can exhaust the per-IP buckets quickly. See [architecture.md](architecture.md#rate-limiting) for the per-request breakdown to size WAF rules or pilot limits from.

**Activity log**

| Variable | Default | Description |
|---|---|---|
| `ACTIVITY_LOG_MAX_ENTRIES` | `1000` | Maximum activity log entries retained per user. Oldest rows are pruned every 5 minutes. |
| `ACTIVITY_SINK_POSTGRES` | `true` | Write events to the `activity_logs` table. Set to `false` to disable. |
| `ACTIVITY_SINK_STDOUT` | `false` | Emit each event as a newline-delimited JSON line to stdout. Useful for log aggregators that scrape stdout (e.g. Loki, Datadog agent). |
| `ACTIVITY_SINK_WEBHOOK_URL` | — | HTTP endpoint to POST each event to as JSON (`Content-Type: application/json`). Failures are logged as warnings and do not affect the tool call. |

Multiple sinks can be active simultaneously. Set `ACTIVITY_SINK_POSTGRES=false` and configure a webhook or stdout sink to route events exclusively to an external system.

**Identity**

| Variable | Default | Description |
|---|---|---|
| `FORWARDED_CLAIMS` | — | Comma-separated list of token claim names to forward to executors in the RPC envelope's `user_claims` field. Empty = forward every non-registered claim on the caller's access token (registered claims such as `iss`, `aud`, `exp` and `iat` are never forwarded). The envelope also carries `user_sub` (the asterism `sub`) and `user_groups`. Set this to restrict forwarding to specific claims only — useful for data minimization when [hub Tier-1 identity resolution](hub.md) only needs one custom claim. |

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

Written by `constellation relay login`. Stores the sign-in used by `constellation relay *` commands. Not used by the node daemon.

```yaml
relay_url: https://your-relay.example.com
access_token: <secret>               # asterism access token (JWT)
access_token_expires_at: "2026-06-25T10:00:00.000Z"
refresh_token: <secret>              # rotates on every refresh
refresh_token_expires_at: "2026-07-25T10:00:00.000Z"
```

The CLI refreshes the access token silently once it is within 30 seconds of expiring. asterism rotates the refresh token on every use, and the new one is written to the file before the new access token is used. `refresh_token_expires_at` is an absolute 30 days from `relay login`; rotation does not extend it. Refreshes are serialized across processes with a `relay-session.yaml.lock` file next to the session file, because asterism treats a second use of an old refresh token as theft and ends the whole grant. If the refresh token is spent, revoked (for example in asterism's `/grants` page) or past its 30 days, the CLI reports "Session expired": in an interactive terminal it starts a new sign-in, otherwise run `constellation relay login` again. `refresh_token` and `refresh_token_expires_at` are omitted if asterism did not issue a refresh token. Admin commands do not use this file: their `relay admin` token is held in memory for one command.

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
| `--relay <url>` | `login`, and the admin commands (`hub-shares list`, `token create --shared`) | Relay URL. Defaults to `relay_url` from `node.yaml` if not given. Position right after `relay`, e.g. `constellation relay --relay <url> login`. Other `relay` subcommands use the relay URL already stored in `relay-session.yaml` from a prior `login` and don't accept this flag. |
| `--json` | `executors list`, `shares list`, `filters list`, `hub-shares list` | Emit machine-readable JSON output. |
| `--executor <id>` | `shares list`, `filters add`, `hub-shares list` | Filter results or scope a filter to a specific executor ID. |
| `--type glob\|regex` | `filters add` | Pattern type for a new deny filter. Default: `glob`. |
