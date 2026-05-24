# Broker Reference

The broker is a stateful HTTP/WebSocket server that sits between MCP clients and agents. It owns authentication, routing, and path filtering. Agents connect out to the broker — the broker never initiates connections inward.

---

## Architecture

```
MCP client (Claude, Cursor, Copilot)
    │  HTTPS + OAuth Bearer
    ▼
  POST /mcp
    │
  [auth middleware — resolves Bearer token to userId]
    │
  MCP tool call
    │
  [router — rate check → label resolution → filter check → liveness check]
    │
  dispatchRpc → WebSocket frame → agent
    │
  ← RPC response (or timeout)
    │
  ← MCP tool response
```

Agents connect over WebSocket to `wss://<broker>/agent/connect` using a long-lived bearer token. The broker keeps one connection per agent in memory and heartbeats it with WebSocket pings.

---

## Configuration Reference

All values are read from `packages/broker/.env`. This file is shared by both the broker and the Postgres container in Docker Compose — set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` here and make sure `DATABASE_URL` uses the same credentials. The broker refuses to start if `TRUST_PROXY` is absent.

### Required

| Variable | Description |
|---|---|
| `POSTGRES_USER` | Postgres username (also read by the Postgres container) |
| `POSTGRES_PASSWORD` | Postgres password (also read by the Postgres container) |
| `POSTGRES_DB` | Postgres database name (also read by the Postgres container) |
| `DATABASE_URL` | PostgreSQL connection string — must match the `POSTGRES_*` values above |
| `OIDC_ISSUER` | OIDC provider issuer URL (e.g. `https://accounts.google.com`) |
| `OIDC_CLIENT_ID` | Client ID from your OIDC provider |
| `OIDC_CLIENT_SECRET` | Client secret from your OIDC provider |
| `OIDC_CALLBACK_URL` | Full URL of `/oauth/callback` on this broker |
| `BROKER_URL` | Public base URL, no trailing slash (e.g. `https://broker.example.com`) |
| `TRUST_PROXY` | Comma-separated list of trusted reverse proxy IP addresses or CIDR ranges. Required by Express to correctly read `X-Forwarded-For`. Example: `127.0.0.1` for a single local proxy, or `127.0.0.1,10.0.0.0/8` for a local proxy plus an internal network. Numbers and booleans are rejected. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port the HTTP server binds to |
| `NODE_ENV` | — | Set to `production` to enable `Secure` on cookies |
| `OAUTH_ACCESS_TOKEN_TTL_HOURS` | `24` | Lifetime of MCP client access tokens |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | Lifetime of MCP client refresh tokens |
| `RPC_TIMEOUT_MS` | `30000` | Maximum wait for an agent to respond to a tool call |
| `HEARTBEAT_INTERVAL_SECONDS` | `60` | How often the broker pings each connected agent |
| `HEARTBEAT_MAX_MISSED` | `3` | Consecutive missed pongs before the agent connection is terminated |
| `RATE_LIMIT_TOOL_CALLS_PER_MIN` | `60` | Standard tool call limit per user per 60-second sliding window |
| `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN` | `20` | Limit for expensive tools (`grep_files`, `search_files`, recursive `list_directory`) per user per 60-second window |
| `RATE_LIMIT_OAUTH_PER_15MIN` | `10` | Requests to `/oauth/token` and `/oauth/register` per IP per 15 minutes |
| `RATE_LIMIT_WS_RECONNECT_PER_MIN` | `10` | WebSocket reconnect attempts per agent token per 60-second window |

An agent is considered **online** when `now - last_heartbeat_at < HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED × 1000 ms`.

---

## Management API

All `/api/*` endpoints require a `broker:manage`-scoped Bearer token (obtained via `constellation broker login`). Tokens without that scope receive `403 insufficient_scope`.

All error responses follow:
```json
{ "error": "<code>", "error_description": "<human-readable>" }
```

---

### `GET /api/status`

Broker health check. No auth required.

**Response `200`**
```json
{
  "status": "ok",
  "uptime_seconds": 3724,
  "version": "0.1.0"
}
```

---

### `GET /api/agents`

List all agents registered to the authenticated user.

**Response `200`** — array of agent objects:

| Field | Type | Description |
|---|---|---|
| `id` | string | Agent ID (cuid) |
| `host` | string | Host name assigned at registration |
| `registered_at` | ISO 8601 | When the agent was first registered |
| `last_heartbeat_at` | ISO 8601 \| null | Last successful heartbeat pong |
| `online` | boolean | Whether the last heartbeat is within the threshold |
| `connected` | boolean | Whether a live WebSocket is open right now |
| `token_id` | string | Current agent token ID |
| `token_last_used_at` | ISO 8601 \| null | Last time the token authenticated a connection |
| `labels` | `{ label, reported_path }[]` | Path labels reported by the agent |

---

### `DELETE /api/agents/:id/token`

Revoke an agent's token. Any active WebSocket for that agent is terminated immediately. The agent will fail to reconnect until re-initialized.

**Path params**: `id` — agent ID from `GET /api/agents`.

**Responses**

| Status | Meaning |
|---|---|
| `204` | Token revoked |
| `404` | Agent not found or belongs to another user |
| `409` | Token already revoked |

---

### `GET /api/labels`

List path labels for the authenticated user.

**Query params**

| Param | Description |
|---|---|
| `agent_id` | Filter to a specific agent (optional) |

**Response `200`** — array:

| Field | Type |
|---|---|
| `id` | string |
| `label` | string |
| `reported_path` | string — absolute path on the agent machine |
| `agent_id` | string |
| `host` | string |

---

### `GET /api/filters`

List active broker path filters for the authenticated user.

**Response `200`** — array:

| Field | Type | Description |
|---|---|---|
| `id` | string | Filter ID |
| `pattern` | string | Glob or regex pattern |
| `pattern_type` | `"glob"` \| `"regex"` | |
| `scope_agent_id` | string \| null | Null = applies to all agents |
| `created_at` | ISO 8601 | |

---

### `POST /api/filters`

Add a broker path filter.

**Request body**

| Field | Required | Description |
|---|---|---|
| `pattern` | yes | Glob or regex string |
| `pattern_type` | yes | `"glob"` or `"regex"` |
| `agent_id` | no | Scope to a specific agent; omit for all agents |

Regex patterns are validated server-side before storage. Invalid patterns return `400`.

**Response `201`** — the created filter object (same shape as `GET /api/filters` entries).

**Responses**

| Status | Meaning |
|---|---|
| `201` | Filter created |
| `400` | Missing/invalid fields, or invalid regex |
| `404` | `agent_id` specified but not found for this user |

---

### `DELETE /api/filters/:id`

Remove a path filter.

**Responses**

| Status | Meaning |
|---|---|
| `204` | Deleted |
| `404` | Not found or belongs to another user |

---

### `GET /api/sessions`

List active MCP client OAuth sessions (non-expired only).

**Response `200`** — array:

| Field | Type | Description |
|---|---|---|
| `id` | string | Session ID |
| `mcp_client_id` | string | OAuth client that holds this session |
| `is_dynamic_client` | boolean | Whether the client was registered via Dynamic Client Registration |
| `issued_at` | ISO 8601 | |
| `expires_at` | ISO 8601 | Access token expiry |
| `has_refresh_token` | boolean | |
| `refresh_token_expires_at` | ISO 8601 \| null | |

---

### `DELETE /api/sessions/:id`

Revoke an OAuth session. Both access and refresh tokens are invalidated immediately by setting their expiry to now.

**Responses**

| Status | Meaning |
|---|---|
| `204` | Session revoked |
| `404` | Not found or belongs to another user |

---

### `POST /api/account/deactivate`

Deactivate the authenticated user's account. All subsequent token lookups for this user will fail with `account deactivated`.

**Request body**
```json
{ "confirm": "deactivate my account" }
```

The `confirm` field must be exactly `"deactivate my account"`. Any other value returns `400 confirmation_required`.

**Responses**

| Status | Meaning |
|---|---|
| `204` | Account deactivated |
| `400` | Confirmation string missing or wrong |

---

## OAuth Flows

The broker acts as an OAuth 2.0 authorization server backed by an upstream OIDC provider. It exposes a standard `/.well-known/oauth-authorization-server` discovery document.

### Authorization Code Flow (MCP clients)

Used by Claude, Cursor, Copilot, and any OAuth 2.0 client.

```
Client                    Broker                    OIDC Provider
  │                         │                            │
  │  GET /oauth/authorize   │                            │
  │ ──────────────────────► │                            │
  │                         │  redirect → OIDC /authorize│
  │ ◄──────────────────── 302                            │
  │                         │                            │
  │  browser follows redirect                            │
  │ ────────────────────────────────────────────────────►│
  │  user authenticates                                  │
  │ ◄────────────────────────────────────────────────────│
  │  GET /oauth/callback?code=...                        │
  │ ──────────────────────►│                             │
  │                         │  exchange code with OIDC   │
  │                         │ ──────────────────────────►│
  │                         │ ◄──────────────────────────│
  │                         │  upsert user row           │
  │  302 → client redirect_uri?code=...                  │
  │ ◄──────────────────────│                             │
  │  POST /oauth/token      │                            │
  │ ──────────────────────► │                            │
  │  ← access_token + refresh_token                      │
```

PKCE (`S256`) is **required**. The broker rejects `/oauth/authorize` requests that omit `code_challenge`. The MCP auth spec is based on OAuth 2.1, which mandates PKCE for all authorization code flows. All compliant MCP clients (Claude, Cursor, Copilot) support it.

**Dynamic Client Registration** (`POST /oauth/register`, RFC 7591) is supported for clients that auto-discover the broker. GitHub Copilot uses this path. Public clients send `token_endpoint_auth_method: "none"` and receive no client secret.

### Device Code Flow (agent init + broker login)

Used by `constellation agent init` (scope `agent:register`) and `constellation broker login` (scope `broker:manage`).

```
CLI                        Broker                    Browser
  │  POST /oauth/device/code│                            │
  │ ──────────────────────► │                            │
  │  ← device_code, user_code, verification_uri          │
  │                         │                            │
  │  display user_code       │                            │
  │  poll POST /oauth/token  │  user opens /activate     │
  │  (every 5s)             │ ◄──────────────────────── │
  │                         │  OIDC auth + consent form  │
  │                         │ ──────────────────────────►│
  │                         │ ◄──────────────────────────│
  │                         │  POST /activate/confirm    │
  │                         │ ◄──────────────────────── │
  │  poll returns token      │                            │
  │ ◄──────────────────────│                            │
```

- `agent:register` — on approval, the broker creates an `Agent` row and an `AgentToken`, then returns `{ access_token, token_type: "agent", host }`.
- `broker:manage` — issues a standard OAuth session tied to a static first-party client.

Device codes expire after 15 minutes. The polling interval is 5 seconds. Responses follow RFC 8628: `authorization_pending`, `access_denied`, `expired_token`.

### Refresh Token Flow

Standard `grant_type=refresh_token`. Issues a new access token and rotates the refresh token (old refresh token is invalidated on use). Fails if the account is deactivated.

---

## Agent WebSocket Protocol

Agents connect to `wss://<broker>/agent/connect` with:

```
Authorization: Bearer <agent-token>
```

The broker validates the token, enforces the reconnect rate limit, and upgrades the connection. Only one WebSocket per agent is allowed — a new connection from the same agent terminates the previous one.

### Heartbeat

The broker sends a WebSocket `ping` frame every `HEARTBEAT_INTERVAL_SECONDS` seconds. The agent must respond with `pong`. After `HEARTBEAT_MAX_MISSED` consecutive missed pongs, the broker terminates the connection and marks the agent offline.

Each pong updates `last_heartbeat_at` on the agent row, which is what `online` status in `list_hosts` / `GET /api/agents` reflects.

### Control Messages (broker → agent)

All messages are JSON frames.

**`config_update_ok`** — sent after a successful `config_update` from the agent.
```json
{ "type": "config_update_ok" }
```

**`config_update_error`** — validation failed.
```json
{ "type": "config_update_error", "error": "<reason>" }
```

**`token_rotated`** — sent after the agent requests token rotation.
```json
{ "type": "token_rotated", "token": "<new-agent-token>" }
```
The agent must persist the new token and reconnect within **5 minutes**. The broker does not update `agentTokenId` until the agent reconnects with the new token, so the old token remains valid throughout the window. Once the agent reconnects, the old token is revoked atomically with the `agentTokenId` update.

If the agent does not reconnect within 5 minutes, the new token is revoked and the old token continues to work — no lockout occurs.

**Lockout scenario:** if both tokens are independently revoked (e.g. the old token is revoked via the management API while the rotation window is open, and the timer then revokes the new token), the agent cannot reconnect and must re-run `constellation agent init`.

**`update_host_ok`** / **`update_host_error`** — response to a host rename request.
```json
{ "type": "update_host_ok", "host": "<new-name>" }
{ "type": "update_host_error", "error": "<reason>" }
```

**RPC envelope** — forwarded tool calls (see below).

### Control Messages (agent → broker)

**`config_update`** — push path label changes to the broker. Labels not present in the payload are removed. Duplicate labels across agents on the same account are rejected.
```json
{
  "type": "config_update",
  "paths": [
    { "label": "projects", "reported_path": "/home/user/projects" },
    { "label": "dotfiles", "reported_path": "/home/user/.config" }
  ]
}
```

**`rotate_token`** — request a new agent token. The broker generates it, stores it, and sends `token_rotated` back. The old token is revoked on successful reconnect.
```json
{ "type": "rotate_token" }
```

**`update_host`** — rename the agent's host identifier. Fails if the name is already taken by another agent on the same account.
```json
{ "type": "update_host", "host": "new-name" }
```

### RPC Protocol

When an MCP client calls a tool, the broker forwards it to the agent as an RPC envelope:

```json
{
  "request_id": "<16-byte hex>",
  "tool": "<tool-name>",
  "absolute_root": "/home/user/projects",
  "<param>": "<value>"
}
```

The agent responds on the same WebSocket:

```json
{
  "request_id": "<same-id>",
  "result": { ... }
}
```

Or on error:

```json
{
  "request_id": "<same-id>",
  "error": {
    "message": "<human-readable description>",
    "code": "<SCREAMING_SNAKE error code>",
    "<enrichment>": "<value>"
  }
}
```

`error` is always an object with a required `message` field. `code` and the enrichment fields are optional and depend on the error type:

| `code` | Trigger | Extra fields |
|---|---|---|
| `EDIT_NO_MATCH` | `edit_file` — `old_text` matched zero times | `edit_index` (0-based), `match_count: 0` |
| `EDIT_AMBIGUOUS` | `edit_file` — `old_text` matched more than once | `edit_index` (0-based), `match_count: N` |
| `FILE_TOO_LARGE` | `read_file` — full file exceeds cap | `read_size_kb`, `max_file_size_kb` |
| `READ_TOO_LARGE` | `read_file` — range result exceeds cap | `read_size_kb` (size of the attempted range), `max_file_size_kb` |
| `DEST_EXISTS` | `copy` / `move` — destination already exists | `path` |
| _(absent)_ | Path rejected, unknown tool, unexpected error | — |

The broker resolves the label to an `absolute_root` before dispatching, so the agent never sees label names — only absolute paths. The agent enforces its own path restrictions against that root.

Requests time out after `RPC_TIMEOUT_MS` milliseconds. When an agent disconnects, all outstanding RPCs for it are rejected immediately.

---

## Path Filters

Path filters are broker-side deny rules applied before an RPC is dispatched. They let you block specific paths from being accessible, even if the agent would otherwise allow them.

Filters are evaluated against every path field in the tool call:

- `relative_path` — used by most tools; falls back to `absolute_root` alone when absent.
- `src_relative_path` — evaluated against the source label root for `copy` and `move`.
- `dst_relative_path` — evaluated against the destination label root for `copy` and `move` (uses `dst_root` for cross-label operations).

A call is blocked if **any** of its candidate paths matches a filter.

### Pattern types

**Glob** — uses [micromatch](https://github.com/micromatch/micromatch) syntax.
```
/home/user/projects/secret/**
*.env
**/.git/**
```

**Regex** — a JavaScript `RegExp`. Validated at creation time; invalid patterns are rejected with `400`.
```
/home/user/secrets/.*\.key$
```

### Scope

Filters are per-user. Each filter can optionally be scoped to a specific agent (`scope_agent_id`). Filters with `scope_agent_id: null` apply to all agents on the account.

A path is blocked if **any** matching filter matches it — there is no allow override.
