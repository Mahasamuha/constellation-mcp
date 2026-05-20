# MCP File Broker — Full Plan

---

## Overview

A network-accessible broker that acts as the MCP server for any MCP client. Users run a local agent on any machine — behind a firewall, VPN, or NAT — and the agent connects outbound to the broker via WebSocket. The broker authenticates MCP clients via OAuth (backed by a generic OIDC provider), routes MCP tool calls to the correct agent, and returns results. The agent is the security boundary for filesystem access; the broker cannot expand its permissions.

---

## Components

| Component | Runs where | Responsibility |
|---|---|---|
| Broker | VPS, Railway, or Fly | MCP server, OAuth AS, WebSocket hub, request routing, liveness tracking |
| Local agent | User's machine | WebSocket client, filesystem ops, path enforcement |
| Postgres | Broker host (sidecar container or managed add-on) | Persistent config, label registry, OAuth sessions |

**Stack:** TypeScript throughout. Broker on Node.js; agent distributed as a single `constellation` binary (npm package or standalone). Prisma for database access and schema migrations. Pino for structured logging.

---

## Broker Internals

### MCP Layer

- Streamable HTTP transport
- Exposes `/.well-known/oauth-authorization-server` for MCP client discovery
- Tools: see MCP Tool Interface section

### OAuth Layer

The broker is an OAuth 2.0 AS to MCP clients and an OIDC client to the upstream provider:

```
MCP client → broker /oauth/authorize → upstream OIDC provider
           ← broker issues its own bearer token scoped to user
```

Any OIDC-compliant provider works. Common choices:

| Provider | Notes |
|---|---|
| Google | Simplest for personal use; free |
| Azure AD | Natural fit for Microsoft-ecosystem deployments or Copilot Studio users |
| Authentik | Self-hosted, open source; good option if you want no external auth dependency |

Required endpoints:
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`
- `/oauth/token` — handles `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` grant types
- `/oauth/register` — Dynamic Client Registration (DCR); most MCP clients attempt this automatically on first connect
- `/oauth/device/code` — Device Authorization Grant; accepts a `scope` parameter to distinguish flows: `scope=agent:register` for `constellation agent init`, `scope=broker:manage` for `constellation broker login`. The `/activate` consent page renders differently for each scope — agent registration shows the host name field and path summary; broker login shows a simple management access confirmation.
- `/activate` — browser-facing consent page for device auth; displays user code, authenticates via OIDC, confirms host name and grants access

**Client registration strategy:** Support DCR as the primary path — it's what Claude, Cursor, and GitHub Copilot all attempt first and eliminates per-client pre-registration for most cases. Also support pre-registered static clients for operators who want to restrict which clients can connect.

Known client callback URLs for pre-registration or documentation:

| Client | OAuth callback URL | Notes |
|---|---|---|
| claude.ai | `https://claude.ai/api/mcp/auth_callback` | Uses DCR; pre-registration optional |
| Cursor | `cursor://anysphere.cursor-mcp/oauth/callback` | Uses DCR with PKCE |
| GitHub Copilot | Varies by IDE; attempts DCR first | Falls back to static client credentials if DCR unsupported |
| Copilot Studio | Provided dynamically after server is added in the UI | Cannot be pre-registered; add post-setup |

Upstream OIDC callback: broker domain.

### WebSocket Hub

- Agents connect to `/agent/connect` with agent token in Authorization header
- Broker validates token → looks up persistent agent config from DB
- In-memory map: `agent_id → WebSocket connection`
- Heartbeat tracked per agent; the WebSocket connection is the only ephemeral state — all config persists in DB

**Config updates:** the agent may send a `{ type: "config_update", paths: [{ label, reported_path }, ...] }` message at any time. The broker upserts `path_labels` for the agent in the DB — adding new labels, updating reported paths on existing ones, and removing labels no longer present in the payload. Label uniqueness is enforced; conflicts return a structured error to the agent. This keeps routing and display information current without requiring re-registration or restart.

### WebSocket Resilience

**Reconnection:** The agent implements exponential backoff reconnect. Because all config is stored in the DB and loaded at startup, reconnection is fully stateless — no handshake beyond token validation is required. The broker resumes sending pings once the new connection is established.

**In-flight operations:** WebSockets do not auto-reconnect; if a connection drops while the broker is awaiting an RPC response, the pending request has no connection to reply to. Behavior:

- The broker abandons the pending RPC and the request hits the 30s timeout, returning a timeout error to the MCP client
- Operations are not retried automatically — the user or model must retry
- Any filesystem operation that was mid-execution on the agent is left in its current state; there is no rollback
- Most filesystem ops complete well within the timeout; this is only a concern for large writes or searches over deep trees

This is acceptable for v1. If retry-on-reconnect becomes necessary, the RPC envelope already carries a `request_id` that could support idempotent replay.

### Request Router

1. Validate MCP client's bearer token → resolve `user_id`
2. Resolve label (and optional host parameter) → target `agent_id` and `absolute_path_root`
3. Apply broker-side deny filters if configured
4. Look up active WebSocket for `agent_id`
5. If no active connection: return informative error (see Error Taxonomy)
6. Forward RPC: `{ request_id, tool, absolute_root, relative_path, ...tool_params }`
7. Await response with configurable timeout (~30s)
8. Return result or structured error to MCP client

### Broker Path Filters

Optional deny-only overlay. Glob or regex patterns defined per user or per agent via `constellation broker`. Can only restrict what reaches the agent — cannot grant access to paths the agent hasn't allowed locally. Applied at the router before forwarding. Pattern type (`glob` | `regex`) is specified explicitly at creation — glob patterns use micromatch syntax; regex patterns are JavaScript-compatible.

---

## Local Agent Internals

### Config (local files, read-only at runtime)

**`agent.yaml`** — connection and runtime config:
```yaml
broker_url: wss://your-broker.example.com
agent_token: <written automatically by constellation agent init>
host: home-server  # optional — if absent, set during init consent flow
max_file_size_kb: 100
```

**`paths.yaml`** — path label definitions:
```yaml
paths:
  - label: projects
    path: /home/user/documents/projects
  - label: dotfiles
    path: /home/user/.config
```

- Written by `constellation agent init` during setup; `host` written on first init if not already present in config
- One inbound WebSocket control message is permitted to modify config: `token_rotated` (broker response to agent's rotation request) — all others are logged and dropped
- Outbound control messages from the agent to the broker: `rotate_token`, `update_host`, `config_update`
- Config file changes are not watched; the user runs `constellation agent sync` to push updates to the broker
- The agent's local config is the sole authority for allowed paths at runtime — `constellation agent sync` keeps the broker's routing and display information current
- `max_file_size_kb` is enforced at the agent; broker-side cap is advisory only

### Agent Init Flow

First-time setup uses the OAuth Device Authorization Grant (RFC 8628) — the same pattern as the AWS and GitHub CLIs:

1. User runs `constellation agent init --broker https://your-broker.example.com`
2. Agent calls broker's `/oauth/device/code` endpoint, passing `host` if already set in local config
3. Broker returns a `user_code` and `verification_uri`
4. Agent prints the code and URL, and attempts to open the browser automatically:
   ```
   Open the following URL to authenticate (opening browser automatically):
   https://your-broker.example.com/activate

   If the browser did not open, enter this code: ABCD-1234
   ```
5. User authenticates via the configured OIDC provider if not already logged in
6. User sees a consent page: pre-filled host name (if provided by agent) or a prompt to name the host; user confirms and grants access
7. Agent polls `/oauth/token` with `grant_type=device_code` until the user completes consent
8. Broker issues an agent token and returns it to the polling CLI, along with the confirmed host name
9. Agent writes the token and host name to the local config file and connects immediately

No token is ever manually copied. The config file is written once and managed automatically thereafter.

### Agent Token Rotation

Rotation is initiated by the agent via the `constellation agent rotate` CLI command — the broker cannot push a new token unsolicited:

1. User runs `constellation agent rotate`
2. Agent sends a `{ type: "rotate_token" }` request to the broker over the existing WebSocket
3. Broker generates a new `agent_tokens` row; updates `agents.agent_token_id` to the new token's ID
4. Broker returns `{ type: "token_rotated", token: "<new_token>" }` to the agent
5. Agent writes the new token to the local config file
6. Agent reconnects using the new token
7. Broker marks the old token `revoked_at` once the new connection is established

The broker UI exposes only revocation — not rotation. Revocation immediately invalidates the token; the agent goes offline and must re-run `constellation agent init` to reconnect.

**Race condition:** if the agent crashes between receiving `token_rotated` and writing the new token to disk, it will restart with the old token — which the broker revokes once the new connection is established. The agent would be permanently locked out and must re-run `constellation agent init`. This window is small in practice but unrecoverable without re-init.

### Agent Host Update

The agent can push a host name update to the broker at any time over the existing WebSocket connection:

1. User updates `host` in `agent.yaml`
2. On next startup (or via `constellation agent rename <host>` CLI command), agent sends a `{ type: "update_host", host: "<new_host>" }` control message
3. Broker validates the new host name is unique for the user and updates `agents.host` in the DB
4. If the host name conflicts with an existing registration, broker returns a structured error and the agent logs it — config is unchanged

### Startup Sequence

1. Load and validate local config
2. Open WebSocket to broker; send agent token in Authorization header
3. Broker validates token → associates connection with `agent_id`
4. Agent automatically sends a `config_update` message with current path labels — broker upserts `path_labels` in DB, ensuring routing is always current without manual intervention
5. Broker begins sending ping frames every `HEARTBEAT_INTERVAL_SECONDS`; agent's WS library handles pong automatically

`constellation agent sync` is an on-demand command for pushing config changes mid-session without restarting — it sends the same `config_update` message as step 4.

### Request Handling

1. Receive RPC from broker
2. Validate `absolute_root` against local allowlist — enforced independently of broker
3. Resolve final path: join root + relative_path
4. Validate resolved path does not escape root (traversal check)
5. Execute operation
6. Respond: `{ request_id, result }` or `{ request_id, error }`

**Reconnect:** exponential backoff; config is local so reconnect is stateless.

---

## Agent Registration Flow

Registration is a one-time setup driven by `constellation agent init` on the user's machine:

1. User runs `constellation agent init --broker https://your-broker.example.com`
2. Agent initiates the OAuth Device Authorization Grant flow with the broker
3. User authenticates via the configured OIDC provider and completes the consent page — setting the host name if not already in local config
4. Broker issues an agent token and returns it to the polling CLI, along with the confirmed host name
5. Agent writes token and host name to local config, connects to broker, and sends initial `config_update` with path labels
6. Broker stores the agent registration and upserts path labels in DB

Label uniqueness is enforced at registration time — conflicts are surfaced during the consent flow, not at runtime.

---

## Liveness Tracking

- Broker sends a WebSocket ping frame to each connected agent every `HEARTBEAT_INTERVAL_SECONDS`
- Agent's WS library responds with a pong frame automatically — no agent-side heartbeat code required
- Broker hooks into the `pong` event to update `last_heartbeat_at` in the DB
- If no pong is received within `HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED`, broker terminates the connection and removes it from the in-memory map
- Defaults: `HEARTBEAT_INTERVAL_SECONDS=60`, `HEARTBEAT_MAX_MISSED=3` (connection terminated after ~180s of silence)
- On disconnect: config untouched; liveness goes stale after threshold
- Labels and host registration persist regardless of liveness state

---

## MCP Tool Interface

Labels are the primary routing key (unique per user across all hosts). Host is available as a conversation dimension for scoping and orientation.

| Tool | Parameters | Notes |
|---|---|---|
| `list_hosts` | — | Returns registered hosts with liveness status and labels |
| `list_labels` | `host?` | Returns labels, optionally filtered by host |
| `list_directory` | `label, relative_path?, recursive?, max_depth?, limit?, exclude?` | Lists label root or subdirectory. `recursive: true` traverses subdirectories. `max_depth` caps traversal depth (default: unlimited when `recursive` is true). `limit` caps total nodes returned (default: 2,000; set to `0` for no limit). `truncated: true` in the response can be triggered by either `limit` or `max_depth` — the response includes `truncated_by: "limit" | "max_depth"` so the caller knows which bound was hit and can adjust accordingly. Callers that need a complete tree should re-call with `limit: 0` and no `max_depth`. Agent enforces a hard maximum of 10,000 nodes regardless of `limit` to prevent runaway traversals. `exclude` is an optional array of glob patterns applied to names (e.g. `["node_modules", ".git", "dist"]`). Non-recursive behavior is unchanged. |
| `file_info` | `label, relative_path` | Returns size, mtime, and type (file/directory/symlink); use before `read_file` to avoid a round-trip size error |
| `search_files` | `label, pattern, relative_path?, type?` | Filename search across a directory tree; `type`: `"glob"` (default, micromatch syntax) or `"regex"` (JavaScript-compatible); rooted at label root or optional subdirectory; returns matching paths; capped at 200 results — if truncated, response includes `truncated: true` and suggests narrowing the pattern or scoping to a subdirectory |
| `read_file` | `label, relative_path, start_line?, end_line?` | Returns full file or specified line range; includes `total_lines` in response; returns size error if full read exceeds cap — use with range params to page |
| `grep_files` | `label, pattern, relative_path?, file_glob?, type?` | Content search; `type`: `"literal"` (default) or `"regex"` (JavaScript-compatible); `relative_path` can be a file (single-file search) or directory (recursive); optional `file_glob` scopes recursive search (e.g. `*.ts`); returns matches with line numbers, always grouped by file regardless of scope; capped at 50 matches and 100KB total output — if truncated, response includes `truncated: true` and suggests a more specific pattern, `file_glob`, or subdirectory scope |
| `write_file` | `label, relative_path, content, mode?` | `mode`: `"overwrite"` (default) or `"append"` |
| `edit_file` | `label, relative_path, edits, dry_run?` | `edits` is an array of `{old_text, new_text}` pairs applied in order. Each `old_text` must match exactly once in the file. Zero matches or more than one match are both errors — the response includes `edit_index` (0-based position in the `edits` array), `match_count`, and a suggestion to make `old_text` more specific by including additional surrounding lines. All edits are validated before any write occurs; a match error on edit N leaves the file untouched. Returns a unified diff of changes made. `dry_run: true` returns the diff without writing. Non-idempotent: re-applying the same edit fails because `old_text` no longer exists. |
| `copy` | `label, src_relative_path, dst_relative_path, dst_label?` | Copies a file or directory within a label root; `dst_label` enables cross-label copy on the same host; fails if destination already exists |
| `create_directory` | `label, relative_path` | Creates directory and any missing parents |
| `delete` | `label, relative_path, recursive?` | Deletes a file or directory. If `relative_path` is a directory and `recursive` is absent or false, returns a structured response with directory size and file count and instructs the caller to confirm by re-calling with `recursive=true` — does not error. Description instructs the model to surface this confirmation to the user before proceeding. `destructiveHint: true` annotation set for clients that support it. |
| `move` | `label, src_relative_path, dst_relative_path, dst_label?` | Within same label root by default; `dst_label` enables cross-label move on the same host |

`read_file` includes `total_lines` in its response so the model can orient itself and decide whether to fetch additional ranges. `list_directory` with `recursive: true` includes `total_nodes` and `truncated` in its response for the same reason.

### Tool Annotations

MCP tool annotations signal behavioral hints to clients that support them. Set the following:

| Tool(s) | Annotations |
|---|---|
| `list_hosts`, `list_labels`, `list_directory`, `file_info`, `search_files`, `grep_files`, `read_file` | `readOnlyHint: true` |
| `write_file`, `create_directory` | `idempotentHint: true` |
| `write_file`, `edit_file`, `delete` | `destructiveHint: true` |
| `edit_file`, `delete` | `idempotentHint: false` |
| `move` | — |

Annotations are advisory — clients that don't support them fall back to the description-level behavior. The two-phase confirmation on `delete` is the primary enforcement mechanism; annotations provide additional coverage where the client surfaces them. `destructiveHint` covers `write_file` (overwrite mode), `edit_file`, and `delete`. `delete` and `edit_file` are both `idempotentHint: false` — deleting a nonexistent path errors, and re-applying an edit fails once `old_text` no longer matches.

### Typical Conversation Patterns

- "Open projects/readme.md" → `read_file(label="projects", relative_path="readme.md")`
- "On my home server" → `list_labels(host="home-server")` to orient, then label-based ops
- "What hosts do I have?" → `list_hosts()`
- Large file encountered → `file_info` to check size, then `read_file` with range params or `grep_files`
- "Find all .env files" → `search_files(label="projects", pattern="**/.env*")`
- "Where is the auth logic?" → `grep_files(label="projects", pattern="authenticate", file_glob="*.ts")`
- "Search just this file" → `grep_files(label="projects", relative_path="src/auth.ts", pattern="authenticate")`
- "Fix this function" → `read_file` to get context, then `edit_file` with `old_text` set to the current function body and `new_text` set to the replacement; use `dry_run: true` first if the change is large
- "Understand this repo's structure" → `list_directory(label="projects", recursive=true, exclude=["node_modules", ".git", "dist"])`
- "Show me the full tree, I need everything" → `list_directory(label="projects", recursive=true, limit=0, exclude=["node_modules", ".git"])`
- "Move this file to the archive label" → `move(label="projects", src_relative_path="old.md", dst_label="archive", dst_relative_path="old.md")`

---

## Error Taxonomy

| Condition | Error |
|---|---|
| Label not registered | "No label 'projects' found on your account" |
| Label registered, host offline | "'projects' is on 'home-server', which was last seen 4 minutes ago" |
| Host name not found | "No host 'work-laptop' registered on your account" |
| Host offline (direct reference) | "'home-server' is registered but currently offline" |
| File exceeds size cap | "File is 4.2MB; max for full read is 100KB — use read_file with range params or grep_files" |
| Path outside allowlist (MCP client) | `"Path rejected by agent"` — deliberately terse; no internal path info leaked to the caller |
| Path outside allowlist (broker log) | Structured log entry including `agentId`, `tool`, `absoluteRoot`, and `resolvedPath` — full detail for admin troubleshooting, never forwarded to MCP client |
| Destination already exists (copy) | "Destination 'projects/archive/old.md' already exists — delete it first or choose a different path" |
| Cross-label move/copy, labels on different hosts | "'projects' is on 'home-server' and 'archive' is on 'work-laptop' — cross-host move/copy is not supported" |
| Timeout | "No response from 'home-server' within 30s" |
| edit_file: old_text not found | Structured error: `{ edit_index, match_count: 0, message: "No match found for edit 2 — fetch current file content and retry" }` |
| edit_file: old_text matches multiple times | Structured error: `{ edit_index, match_count: N, message: "N matches found for edit 2 — expand old_text to include more surrounding context" }` |
| list_directory: hard node cap reached | Structured error with count reached; instructs caller to scope to a subdirectory or use search_files instead |

---

## Data Model

```sql
users
  id, oidc_sub, oidc_issuer, email, created_at, deactivated_at (nullable)

agent_tokens
  id, user_id, token_hash, created_at, last_used_at, revoked_at (nullable)

agents
  id, user_id, agent_token_id, host,
  registered_at, last_heartbeat_at
  UNIQUE (user_id, host)

path_labels
  id, user_id, agent_id, label, reported_path
  UNIQUE (user_id, label)

broker_path_filters
  id, scope_user_id, scope_agent_id (nullable),
  pattern, pattern_type (glob|regex), created_at

oauth_clients
  id (client_id), client_secret_hash (nullable — public clients omit),
  redirect_uris, grant_types, is_dynamic, created_at

oauth_sessions
  id, user_id, mcp_client_id,
  access_token_hash, issued_at, expires_at,
  refresh_token_hash (nullable), refresh_token_expires_at (nullable)
```

`reported_path` is pushed by the agent via `config_update` on startup and `constellation agent sync`; it is informational — used for display only. The agent's local config is authoritative. `revoked_at` on `agent_tokens` is nullable; `IS NOT NULL` is the revocation check, removing the need for a separate boolean. `last_used_at` on `agent_tokens` is updated on each WebSocket connection using that token. `deactivated_at` on `users` is nullable; when set, the broker rejects all MCP requests and agent connections for that user — config and registrations are preserved but inert. `refresh_token_hash` and `refresh_token_expires_at` on `oauth_sessions` are nullable — not all clients request a refresh token. `pattern_type` on `broker_path_filters` is an enum (`glob` | `regex`) set at filter creation; glob patterns use micromatch syntax, regex patterns are JavaScript-compatible. `is_dynamic` on `oauth_clients` distinguishes DCR-registered clients from operator pre-registered ones; the broker may apply different policies to each.

---

## Trust Model Summary

| Layer | Can grant access | Can restrict access |
|---|---|---|
| Agent local config | Yes — sole authority | Yes |
| Broker path filters | No | Yes — deny-only overlay |
| Agent runtime check | — | Always enforced last |

A compromised broker can forward malicious requests and apply additional restrictions, but cannot instruct the agent to open paths beyond what its local config permits. The agent ignores any path-related instructions arriving over the WebSocket.

Agent config files should be `chmod 600`, owned by the agent's user.

---

## Deployment

The broker is a single Node.js process and a Postgres database — straightforward to run anywhere that supports Docker.

### Primary: VPS + Docker Compose

The most portable and self-host-friendly option. Any VPS (Hetzner, DigitalOcean, Linode) running Docker works. No platform lock-in; the entire stack is defined in a `docker-compose.yml`.

```yaml
services:
  broker:
    image: mcp-file-broker
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
    env_file: .env
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

A $6–8/month Hetzner CX22 or DigitalOcean Basic Droplet is sufficient for personal use. Add a reverse proxy (Caddy or nginx) for TLS.

### Alternative: Railway or Fly.io

Both support Docker image deployment and include a managed Postgres add-on, making them a faster path to a running broker without managing a server. Appropriate for getting started quickly; migrate to a VPS if you want more control later.

- **Railway**: dashboard-first, easy Postgres provisioning, usage-based billing
- **Fly.io**: CLI-first, good WebSocket support, 35+ regions; Fly Volumes have had historical durability issues — use an external managed Postgres rather than a Fly-hosted one if deploying here

### Agent

Distributed as an npm package or platform-specific standalone binary (built with `bun build --compile`). The binary is named `constellation`. Runs as a background process; recommended service managers by platform:

| Platform | Service manager | Notes |
|---|---|---|
| Linux | systemd | Unit file shipped with package |
| macOS | launchd | `.plist` file shipped with package; install to `~/Library/LaunchAgents` |
| Windows | Task Scheduler | Runs under current user account; no elevation required in v1 |

Pure TypeScript with no native addons — the npm package is cross-platform without platform-specific builds. Standalone binaries require separate build artifacts per platform/architecture.

---

## Risks and Constraints

- **Logging**: Pino throughout broker and agent. Single JSON stream — human-readable via `pino-pretty` for console monitoring, machine-readable JSON for log aggregators without any configuration difference. Key events logged with structured fields:

  | Event | Key fields |
  |---|---|
  | Agent connect / disconnect | `agentId`, `host`, `userId` |
  | Heartbeat failure / timeout | `agentId`, `lastHeartbeatAt` |
  | MCP tool call | `tool`, `label`, `userId`, `agentId`, `durationMs`, `status` |
  | OAuth token issued / rejected | `mcpClientId`, `userId` |
  | Rate limit hit | `surface`, `userId`, `ip`, or `agentTokenId` (varies by surface) |
  | Path rejected by agent | `agentId`, `tool`, `absoluteRoot`, `resolvedPath` (full detail for admin; never forwarded to MCP client) |
  | Errors | `err` with stack |

- **Rate limiting**: enforced at the broker. Denominator varies by surface — per user for tool calls, per IP for OAuth endpoints, per agent token for WebSocket reconnections. Four tiers with independently tunable parameters (configured via broker environment variables):

  | Surface | Default limit | Parameter |
  |---|---|---|
  | MCP tool calls | 60 requests/minute per user | `RATE_LIMIT_TOOL_CALLS_PER_MIN` |
  | Expensive tools (`grep_files`, `search_files`, `list_directory` with `recursive: true`) | 20 requests/minute per user | `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN` |
  | OAuth endpoints (`/oauth/token`, `/oauth/register`) | 10 requests/15 minutes per IP | `RATE_LIMIT_OAUTH_PER_15MIN` |
  | Agent WebSocket reconnections | 10 reconnects/minute per agent token | `RATE_LIMIT_WS_RECONNECT_PER_MIN` |

  Implementation: in-memory sliding window — `express-rate-limit` for HTTP/OAuth surfaces; a lightweight custom map for WebSocket reconnections. No Redis required for v1; rate limit state is lost on broker restart, which is acceptable.

- **OAuth session expiry and refresh**: access tokens and refresh tokens have configurable lifetimes via broker environment variables. Defaults are 24 hours for access tokens and 30 days for refresh tokens. The broker implements `grant_type=refresh_token` on `/oauth/token` — clients that support it (Claude, Cursor, Copilot) silently refresh without user interaction. Clients that don't will prompt re-auth on expiry. Refresh token fields are nullable; clients that don't request one get access-token-only sessions.

  | Parameter | Default | Description |
  |---|---|---|
  | `OAUTH_ACCESS_TOKEN_TTL_HOURS` | `24` | Access token lifetime in hours |
  | `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime in days |

- **Token format**: agent tokens and OAuth access/refresh tokens are cryptographically random 32-byte values encoded as 64-character hex strings (`crypto.randomBytes(32).toString('hex')`). Stored in the DB as SHA-256 hashes. Never logged in plaintext.
- **Symlink policy**: the agent resolves paths with `fs.realpath()` (follows symlinks to their final target) before validating against the allowlist. A symlink whose resolved target falls outside the allowed root is rejected — same error as a direct traversal attempt. `list_directory` reports symlinks as type `symlink` with a `target` field showing the link destination; symlinked directories are not recursed into unless their resolved path is within the label root.
- **Path traversal check**: `fs.realpath()` + `startsWith(allowedRoot)`. Applied after resolving the full path from `absolute_root` + `relative_path`. Rejects any resolved path that does not begin with the allowed root, including symlink escapes.
- **Exponential backoff**: initial delay 1s, multiplier 2×, ±20% jitter, cap 60s. Agent retries indefinitely until connected or explicitly stopped.
- **RPC timeout**: configurable via `RPC_TIMEOUT_MS` (default `30000`). The broker rejects pending RPC promises after this duration and returns a timeout error to the MCP client.
- **Duplicate agent connection**: if an agent connects with a token that already has an active WebSocket connection, the broker terminates the old connection, logs the replacement, and accepts the new one. Assumes the previous connection is stale (e.g., from a crash without clean disconnect).
- **Horizontal scaling**: the in-memory WebSocket map means the broker can't scale beyond one instance without a shared connection layer (e.g., Redis pub/sub). Single instance is correct for v1; isolate the connection map so it's replaceable later.
- **Dynamic client registration**: Support DCR as the primary path — most MCP clients (Claude, Cursor, GitHub Copilot) attempt it automatically. Also support pre-registered static clients for operators who want to restrict client access. Known callback URLs are documented in the OAuth Layer section.
- **Large file operations**: `read_file` enforces a configurable size cap (default 100KB). When exceeded, returns a structured error with file size and instruction to use `read_file` with range params or `grep_files`. Cap is defined in agent local config. `edit_file` avoids the problem for edits — only the matched `old_text` and replacement `new_text` are transmitted, not the full file.
- **Search result limits**: `search_files` caps at 200 paths; `grep_files` caps at 50 matches and 100KB total output; `list_directory` (recursive) defaults to 2,000 nodes with a hard agent-side ceiling of 10,000. All return `truncated: true` with a refinement hint when the cap is hit. Caps are enforced at the agent.
- **edit_file exact matching**: each `old_text` must match exactly once. Zero matches → error. Two or more matches → error. Both cases abort before any write; the error includes `edit_index` and `match_count` so the caller knows which edit failed and why. For the multiple-match case, the fix is to expand `old_text` to include enough surrounding context (additional lines above or below) to make it unique. The model should fetch context via `read_file` if unsure of the exact current content before constructing edits. Validation runs across all edits before any write, so a failure on edit N never leaves the file partially modified.
- **Agent config integrity**: if the local config file is writable by other processes, the path allowlist can be tampered with outside the agent's control. Document `chmod 600` as a hard requirement.

---

## User Interaction Surfaces

**Hard requirement:** all actions must be accessible from the command line. GUI components are convenience layers on top of CLI-complete functionality — no action should require a GUI. Agent configuration must be fully manageable via well-organized config files without any tooling.

### 1. Broker

Setup and ongoing management of the broker. The broker exposes a `constellation broker` CLI for all management actions and serves a minimal `/activate` consent page for the device auth flow. A full web UI is not in scope for v1 but is not precluded — all management actions are available via API.

**Broker URL resolution:** `constellation broker` commands resolve the target broker in order:
1. `--broker <url>` flag
2. `broker_url` from agent config (`~/.config/constellation/agent.yaml`)
3. Error: `"No broker URL configured. Pass --broker <url> or run constellation agent init first."`

#### Commands

| Command | Description |
|---|---|
| `constellation broker login [--broker <url>]` | OAuth device flow; stores session to `~/.config/constellation/broker-session.yaml` |
| `constellation broker logout` | Invalidates and removes stored session |
| `constellation broker status` | Broker health, uptime, version |
| `constellation broker agents list [--json]` | All agents with liveness, heartbeat, host, and labels |
| `constellation broker agents revoke <agent-id>` | Immediately revoke an agent token |
| `constellation broker labels list [--agent <id>] [--json]` | Path labels, optionally filtered by agent |
| `constellation broker filters list [--json]` | Active deny filters |
| `constellation broker filters add <pattern> [--type glob|regex] [--agent <id>]` | Add a deny filter; type defaults to glob; scoped to user or specific agent |
| `constellation broker filters remove <filter-id>` | Remove a deny filter |
| `constellation broker sessions list [--json]` | Active MCP client sessions with issued and expiry timestamps |
| `constellation broker sessions revoke <session-id>` | Invalidate an MCP client session |
| `constellation broker account deactivate` | Set `deactivated_at`; requires confirmation prompt |

Global flags: `--broker <url>` to override resolved broker; `--json` for machine-readable output on list commands; `--quiet` for scripting.

#### Auth Storage

`constellation broker login` stores its OAuth session separately from the agent token:

```
~/.config/constellation/
  agent.yaml            # agent connection config
  paths.yaml            # path label definitions
  broker-session.yaml   # broker CLI OAuth session (written by broker login)
```

**`broker-session.yaml`** structure:
```yaml
broker_url: https://your-broker.example.com
access_token: <token>
access_token_expires_at: 2025-05-12T10:00:00Z
refresh_token: <token>          # omitted if broker did not issue one
refresh_token_expires_at: 2025-06-11T10:00:00Z
```

`broker-session.yaml` holds the access and refresh tokens for the broker management API, subject to the same expiry rules as MCP client sessions (`OAUTH_ACCESS_TOKEN_TTL_HOURS` / `OAUTH_REFRESH_TOKEN_TTL_DAYS`). Commands silently refresh on expiry if a refresh token is available; otherwise prompt to re-run `constellation broker login`.

#### Account
- **Login** — OIDC login via configured provider; creates user record on first login
- **Logout** — invalidates active OAuth session
- **Deactivate account** — sets `deactivated_at`; preserves all config but blocks all access immediately

#### Agents
- **Register agent** — user runs `constellation agent init` on their machine; broker serves the `/activate` consent page where the user confirms the host name and grants access; token is delivered to the CLI automatically on completion
- **View agents** — lists all registered agents with liveness status, last heartbeat, and associated labels; shows host name per agent
- **Revoke token** — immediately invalidates token; agent goes offline until user re-runs `constellation agent init`

#### Path Labels
- **View labels** — read-only display of labels registered per agent, with `reported_path` from agent config; clearly marked as read-only with instruction to edit agent config for changes

#### Broker Path Filters
- **Create filter** — define a glob or regex deny pattern, scoped to the user or a specific agent
- **View filters** — list active filters with scope and pattern
- **Delete filter** — removes a deny filter

#### MCP Client Sessions
- **View sessions** — lists active OAuth sessions by MCP client, with issued and expiry timestamps
- **Revoke session** — immediately invalidates an MCP client session; client must re-authenticate

### 2. Agent CLI

All agent functionality is accessible via the `constellation agent` CLI and config files. No GUI required.

#### Commands

| Command | Description |
|---|---|
| `constellation agent init [--broker <url>]` | OAuth device flow; writes config files |
| `constellation agent install` | Register with OS service manager; requires escalation on Linux/macOS if installing as a system service — not required for user-scoped installs or Windows Task Scheduler |
| `constellation agent start` | Start the agent service |
| `constellation agent stop` | Stop the agent service |
| `constellation agent restart` | Restart the agent service |
| `constellation agent status [--json]` | Service state, broker connection, path labels, last heartbeat |
| `constellation agent sync` | Push current config to broker |
| `constellation agent rotate` | Request token rotation from broker |
| `constellation agent rename <host>` | Push host name update to broker |
| `constellation agent logs [-f] [--lines <n>]` | Show agent logs; `-f` tails |
| `constellation agent config show` | Display current config (token masked) |
| `constellation agent config edit` | Open config files in `$EDITOR` |
| `constellation agent config path` | Print path to config files |
| `constellation agent paths list [--json]` | List configured path labels |
| `constellation agent paths add <label> <path>` | Add a path label to paths config; prompts to sync |
| `constellation agent paths remove <label>` | Remove a path label from paths config; prompts to sync |

Global flags: `--config <path>` to override config location; `--quiet` for scripting (suppresses prompts, errors to stderr only). Exit codes: 0 success, 1 general error, distinct codes for auth failure and broker unreachable.

#### Config Files

Two files, concerns separated:

**`agent.yaml`** — connection and runtime config:
```yaml
broker_url: wss://your-broker.example.com
agent_token: <managed by constellation agent>
host: home-server
max_file_size_kb: 100
```

**`paths.yaml`** — path label definitions:
```yaml
paths:
  - label: projects
    path: /home/user/documents/projects
  - label: dotfiles
    path: /home/user/.config
```

Default config locations:

| Platform | Path |
|---|---|
| Linux | `~/.config/constellation/` |
| macOS | `~/.config/constellation/` |
| Windows | `%APPDATA%\constellation\` |

#### Service Management

`start`, `stop`, and `restart` wrap the OS service manager transparently:

| Platform | Underlying mechanism |
|---|---|
| Linux | `systemctl --user start/stop/restart constellation` |
| macOS | `launchctl load/unload ~/Library/LaunchAgents/com.constellation.agent.plist` |
| Windows | Task Scheduler via `schtasks` |

`install` registers the agent with the OS service manager. On Linux and macOS, user-scoped installs (systemd user unit, launchd LaunchAgent) do not require escalation. System-wide installs do. Windows Task Scheduler under the current user account never requires escalation.

#### Path Management

`paths add` and `paths remove` modify `paths.yaml` directly, then prompt:
```
Label "projects" added to paths.yaml.
Run `constellation agent sync` to push changes to the broker.
```
Config file is the explicit authority — changes are not auto-pushed.

### 3. MCP Client Connector

Adding the broker as an MCP server in the client. Not fully controllable — flows vary by client. To be documented with concrete examples after prototyping. Known targets: claude.ai, Cursor, GitHub Copilot.

---

## TODO

Items deferred from planning — pick up before implementation begins:

- **MCP client connector documentation** — to be documented with concrete examples after prototyping. Known targets: claude.ai, Cursor, GitHub Copilot.

---

## Future Considerations

- **Broker UI activity log**: surface structured Pino logs through the broker UI — recent tool calls, errors, rate limit hits, and agent connection events per user. Deferred: requires a log storage and query layer (the current Pino stream writes to stdout/aggregator, not a queryable store). A lightweight approach would be a ring buffer in Postgres; a heavier approach would be a dedicated log aggregator integration (Loki, Datadog).

- **Broker web UI**: a full management dashboard served by the broker. All management actions are already available via `constellation broker` and the broker API; a web UI would be a convenience layer on top. Deferred: v1 ships with `constellation broker` and the `/activate` consent page only.

- **Agent GUI**: a graphical interface for `constellation agent` management. All functionality is accessible via CLI and config files; a GUI would be a convenience layer on top. Deferred: v1 ships with `constellation agent` CLI only.

- **Binary / media file reading**: a `read_media_file` tool would return base64-encoded content with MIME type detection, enabling the model to inspect images, audio, and other binary formats stored locally. The main constraint is payload size — binary files passed through the broker and into the model's context window can be large. Deferred pending a clearer use case; the staging pattern (large file transfer) may be the better approach for most binary workflows anyway.

- **Large file transfer (staging pattern)**: for binary files or transfers where the model is orchestrating rather than reading content, the correct approach is agent-to-storage staging — agent uploads to a short-lived pre-signed URL (S3/R2 or equivalent), MCP tool returns the URL for the user to download directly. Keeps large payloads out of the model's context entirely. Deferred: requires storage integration, token lifecycle management, and decisions on whether the broker or agent owns the upload.

- **Shared file server / multi-user agent**: for deployments on a shared machine (NAS, dev server, domain-joined Windows host), a privileged parent agent runs as a system service and spawns per-user sub-agents rather than requiring each user to run their own agent instance. The parent receives an RPC, looks up the target OS user via a local `user_mappings` config (OIDC sub → local username), and spawns a child process running as that user before forwarding the request. Path validation still occurs in the sub-agent running under the correct OS identity, preserving the trust model. The RPC envelope extension point for this is straightforward: the broker adds `user_oidc_sub` (already available from the bearer token) to the forwarded payload. Platform notes: Linux uses Node's native `uid`/`gid` spawn options; Windows uses S4U2Self token impersonation (`LogonUser` with `LOGON32_LOGON_SERVICE`), the same mechanism IIS application pool impersonation uses. macOS is out of scope for this pattern. Deferred: adds installation complexity (privileged service account, user mapping config) not warranted for single-user deployments.
