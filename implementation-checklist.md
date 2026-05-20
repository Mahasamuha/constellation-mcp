# Constellation — Implementation Checklist

Reference: `mcp-file-broker-plan.md`

Tasks are ordered by dependency. Complete each section before moving to the next. Check off tasks as they are completed.

---

## 1. Project Setup

- [x] Initialise monorepo with pnpm workspaces: packages `broker`, `agent`, `shared`
- [x] Configure TypeScript strict mode across all packages
- [x] Add Pino logging to `shared`; configure `pino-pretty` for development
- [x] Set up shared token utilities in `shared`: `generateToken()` (32-byte hex), `hashToken()` (SHA-256)
- [x] Add `.env.example` for broker with all documented env vars (`RPC_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_SECONDS`, `HEARTBEAT_MAX_MISSED`, `OAUTH_ACCESS_TOKEN_TTL_HOURS`, `OAUTH_REFRESH_TOKEN_TTL_DAYS`, `RATE_LIMIT_*`)
- [x] Add Docker Compose file with broker and Postgres services, healthcheck on postgres

---

## 2. Database

- [x] Initialise Prisma in `broker` package; configure Postgres connection
- [x] Define Prisma schema for `users` table (`id`, `oidc_sub`, `oidc_issuer`, `email`, `created_at`, `deactivated_at`)
- [x] Define Prisma schema for `agent_tokens` table (`id`, `user_id`, `token_hash`, `created_at`, `last_used_at`, `revoked_at`)
- [x] Define Prisma schema for `agents` table (`id`, `user_id`, `agent_token_id`, `host`, `registered_at`, `last_heartbeat_at`); unique on `(user_id, host)`
- [x] Define Prisma schema for `path_labels` table (`id`, `user_id`, `agent_id`, `label`, `reported_path`); unique on `(user_id, label)`
- [x] Define Prisma schema for `broker_path_filters` table (`id`, `scope_user_id`, `scope_agent_id`, `pattern`, `pattern_type`, `created_at`)
- [x] Define Prisma schema for `oauth_clients` table (`id`, `client_secret_hash`, `redirect_uris`, `grant_types`, `is_dynamic`, `created_at`)
- [x] Define Prisma schema for `oauth_sessions` table (`id`, `user_id`, `mcp_client_id`, `access_token_hash`, `issued_at`, `expires_at`, `refresh_token_hash`, `refresh_token_expires_at`)
- [x] Run initial Prisma migration; verify schema applies cleanly

---

## 3. Broker — OAuth Layer

- [ ] Implement OIDC client: exchange upstream provider auth code for user identity; upsert `users` row on first login
- [ ] Implement `GET /.well-known/oauth-authorization-server` metadata endpoint
- [ ] Implement `POST /oauth/register` — Dynamic Client Registration; store new `oauth_clients` row with `is_dynamic: true`
- [ ] Implement `GET /oauth/authorize` — redirect to upstream OIDC provider
- [ ] Implement upstream OIDC callback handler — complete auth code exchange, resolve user, redirect back to MCP client
- [ ] Implement `POST /oauth/token` — `authorization_code` grant: issue access + optional refresh token; store hashes in `oauth_sessions`
- [ ] Implement `POST /oauth/token` — `refresh_token` grant: validate refresh token hash, issue new access token
- [ ] Implement `POST /oauth/device/code` — issue `device_code`, `user_code`, `verification_uri`; differentiate `scope=agent:register` vs `scope=broker:manage`
- [ ] Implement `/activate` consent page — display user code, authenticate via OIDC; render agent registration form (host name field) for `agent:register` scope; render simple confirmation for `broker:manage` scope
- [ ] Implement `POST /oauth/token` — `device_code` grant: poll completion; on approval issue token (agent token for `agent:register`, OAuth session for `broker:manage`)
- [ ] Implement bearer token validation middleware: decode token, hash, look up `oauth_sessions`, reject if expired or deactivated user
- [ ] Add rate limiting: `express-rate-limit` on `/oauth/token` and `/oauth/register` — `RATE_LIMIT_OAUTH_PER_15MIN` per IP

---

## 4. Broker — WebSocket Hub

- [ ] Implement `GET /agent/connect` WebSocket upgrade handler: validate agent token (hash lookup in `agent_tokens`, check `revoked_at`), update `last_used_at`
- [ ] On connection: look up agent from DB, add to in-memory `Map<agent_id, WebSocket>`; log connect event with `agentId`, `host`, `userId`
- [ ] Handle duplicate connections: if `agent_id` already in map, terminate old connection, log replacement, accept new
- [ ] Implement broker-initiated ping loop: send WS ping every `HEARTBEAT_INTERVAL_SECONDS`; hook `pong` event to update `agents.last_heartbeat_at`
- [ ] Implement missed heartbeat detection: terminate connection and remove from map after `HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED` without pong; log timeout
- [ ] Handle `config_update` message from agent: upsert `path_labels` (add new, update existing, remove absent); enforce label uniqueness; return structured error on conflict
- [ ] Handle `update_host` message from agent: validate new host is unique for user; update `agents.host`; return error on conflict
- [ ] Handle `rotate_token` message from agent: generate new token, insert `agent_tokens` row, update `agents.agent_token_id`, send `token_rotated` response; mark old token `revoked_at` on successful reconnect with new token
- [ ] On disconnect: remove from in-memory map; log disconnect event
- [ ] Add rate limiting: custom in-memory sliding window on WebSocket reconnections — `RATE_LIMIT_WS_RECONNECT_PER_MIN` per agent token

---

## 5. Broker — Request Router

- [ ] Implement label resolution: given `user_id` + `label` (+ optional `host`), query `path_labels` joined to `agents`; return `agent_id` and `reported_path`
- [ ] Implement broker path filter evaluation: load active `broker_path_filters` for user/agent; apply micromatch (glob) or JS regex against resolved path; reject if any filter matches
- [ ] Implement RPC dispatch: look up agent WebSocket from in-memory map; if absent return offline error; forward RPC envelope `{ request_id, tool, absolute_root, relative_path, ...tool_params }`; await response with `RPC_TIMEOUT_MS` timeout
- [ ] Implement pending RPC map (`Map<request_id, Promise>`): clean up on agent disconnect (reject all pending with timeout error)
- [ ] Add rate limiting: per-user sliding window — `RATE_LIMIT_TOOL_CALLS_PER_MIN`; separate lower limit for expensive tools (`grep_files`, `search_files`, `list_directory` with `recursive: true`) — `RATE_LIMIT_EXPENSIVE_TOOLS_PER_MIN`

---

## 6. Broker — MCP Layer

- [ ] Initialise MCP server with Streamable HTTP transport using `@modelcontextprotocol/sdk`
- [ ] Register `list_hosts` tool: query `agents` for user, return host names with liveness status (compare `last_heartbeat_at` against `HEARTBEAT_INTERVAL_SECONDS × HEARTBEAT_MAX_MISSED`)
- [ ] Register `list_labels` tool: query `path_labels` for user; support optional `host` filter; return labels with `reported_path`
- [ ] Register `list_directory` tool: forward to router; support `recursive`, `max_depth`, `limit`, `exclude` params; handle `truncated_by` response
- [ ] Register `file_info` tool: forward to router; return `size`, `mtime`, `type` (file/directory/symlink)
- [ ] Register `search_files` tool: forward to router; support `type` (glob/regex) param; handle `truncated` response
- [ ] Register `read_file` tool: forward to router; support `start_line`, `end_line` params; handle size cap error
- [ ] Register `grep_files` tool: forward to router; support `file_glob` and `type` params; handle `truncated` response
- [ ] Register `write_file` tool: forward to router; support `mode` (overwrite/append)
- [ ] Register `edit_file` tool: forward to router; support `edits` array and `dry_run`; handle `edit_index`/`match_count` errors
- [ ] Register `copy` tool: forward to router; handle destination-exists error
- [ ] Register `create_directory` tool: forward to router
- [ ] Register `delete` tool: forward to router; handle two-phase recursive confirmation response
- [ ] Register `move` tool: forward to router; support `dst_label`
- [ ] Apply tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) per annotations table in plan
- [ ] Map all error taxonomy cases to structured MCP error responses

---

## 7. Broker — Management API

- [ ] Implement `GET /api/agents` — list agents with liveness, last heartbeat, host, labels
- [ ] Implement `DELETE /api/agents/:id/token` — revoke agent token (set `revoked_at`)
- [ ] Implement `GET /api/labels` — list path labels; support `?agent_id` filter
- [ ] Implement `GET /api/filters` — list broker path filters
- [ ] Implement `POST /api/filters` — create filter; accept `pattern`, `pattern_type`, optional `agent_id`
- [ ] Implement `DELETE /api/filters/:id` — delete filter
- [ ] Implement `GET /api/sessions` — list active OAuth sessions
- [ ] Implement `DELETE /api/sessions/:id` — revoke OAuth session
- [ ] Implement `POST /api/account/deactivate` — set `users.deactivated_at`
- [ ] Implement `GET /api/status` — broker health, uptime, version
- [ ] Apply bearer token auth middleware to all `/api/*` routes; require `broker:manage` scope

---

## 8. Agent — Core

- [ ] Initialise `agent` package; configure TypeScript, Pino logging
- [ ] Implement config loader: read and validate `agent.yaml` and `paths.yaml` from `~/.config/constellation/` (Linux/macOS) or `%APPDATA%\constellation\` (Windows)
- [ ] Implement WebSocket client: connect to `broker_url` with agent token in Authorization header; exponential backoff reconnect (1s initial, 2× multiplier, ±20% jitter, 60s cap)
- [ ] Implement startup `config_update` send: on connection established, immediately push current `paths.yaml` labels to broker
- [ ] Implement outbound control messages: `rotate_token`, `update_host`, `config_update`
- [ ] Implement inbound control message handler: accept `token_rotated` (write new token to `agent.yaml`); log and drop all others
- [ ] Implement RPC handler: receive broker RPC; validate `absolute_root` against `paths.yaml` allowlist; resolve final path with `fs.realpath()`; check resolved path starts with allowed root (traversal + symlink check); dispatch to file operation; respond `{ request_id, result }` or `{ request_id, error }`
- [ ] Implement `list_directory` operation: support `recursive`, `max_depth`, `limit`, `exclude`; enforce 10,000 node hard cap; return `truncated`, `truncated_by`
- [ ] Implement `file_info` operation: return `size`, `mtime`, `type`; report symlinks as `symlink` with `target` field
- [ ] Implement `search_files` operation: filename search with micromatch (glob) or JS regex; cap at 200 results
- [ ] Implement `read_file` operation: full file or line range; enforce `max_file_size_kb` cap; include `total_lines`
- [ ] Implement `grep_files` operation: literal or regex content search; always group by file; cap at 50 matches and 100KB output
- [ ] Implement `write_file` operation: overwrite and append modes
- [ ] Implement `edit_file` operation: validate all `old_text` matches (exactly once each) before any write; apply edits; return unified diff; support `dry_run`
- [ ] Implement `copy` operation: file and directory copy; fail if destination exists
- [ ] Implement `create_directory` operation: mkdir with parents
- [ ] Implement `delete` operation: file deletion; directory deletion — return summary if `recursive` absent, delete if present
- [ ] Implement `move` operation: within label root and cross-label on same host via `dst_label`

---

## 9. Agent — CLI (`constellation agent`)

- [ ] Set up CLI entry point with subcommand routing (`agent`, `broker`); use `commander` or equivalent
- [ ] Implement `constellation agent init [--broker <url>]`: device flow (`scope=agent:register`), poll `/oauth/token`, write `agent.yaml` and `paths.yaml`
- [ ] Implement `constellation agent install`: register with OS service manager (systemd user unit on Linux, launchd LaunchAgent on macOS, Task Scheduler on Windows); no escalation required for user-scoped installs
- [ ] Implement `constellation agent start` / `stop` / `restart`: wrap OS service manager commands transparently
- [ ] Implement `constellation agent status [--json]`: show service state, broker connection, labels, last heartbeat
- [ ] Implement `constellation agent sync`: send `config_update` to broker with current `paths.yaml` contents
- [ ] Implement `constellation agent rotate`: send `rotate_token` request; write returned token to `agent.yaml`
- [ ] Implement `constellation agent rename <host>`: send `update_host` message; update `agent.yaml` on success
- [ ] Implement `constellation agent logs [-f] [--lines <n>]`: read from OS service log; tail with `-f`
- [ ] Implement `constellation agent config show`: print `agent.yaml` and `paths.yaml` with token masked
- [ ] Implement `constellation agent config edit`: open config files in `$EDITOR`
- [ ] Implement `constellation agent config path`: print config directory path
- [ ] Implement `constellation agent paths list [--json]`: list labels from `paths.yaml`
- [ ] Implement `constellation agent paths add <label> <path>`: append to `paths.yaml`; prompt to run `constellation agent sync`
- [ ] Implement `constellation agent paths remove <label>`: remove from `paths.yaml`; prompt to run `constellation agent sync`

---

## 10. Broker CLI (`constellation broker`)

- [ ] Implement `constellation broker login [--broker <url>]`: device flow (`scope=broker:manage`), poll `/oauth/token`, write `broker-session.yaml` (`broker_url`, `access_token`, `access_token_expires_at`, `refresh_token`, `refresh_token_expires_at`)
- [ ] Implement `constellation broker logout`: delete `broker-session.yaml`
- [ ] Implement broker URL resolution: `--broker` flag → `broker_url` from `agent.yaml` → error with help message
- [ ] Implement silent token refresh: before each API call, check `access_token_expires_at`; refresh if expired and refresh token available; prompt re-login if not
- [ ] Implement `constellation broker status`: call `GET /api/status`
- [ ] Implement `constellation broker agents list [--json]`: call `GET /api/agents`
- [ ] Implement `constellation broker agents revoke <agent-id>`: call `DELETE /api/agents/:id/token`; confirm before executing
- [ ] Implement `constellation broker labels list [--agent <id>] [--json]`: call `GET /api/labels`
- [ ] Implement `constellation broker filters list [--json]`: call `GET /api/filters`
- [ ] Implement `constellation broker filters add <pattern> [--type glob|regex] [--agent <id>]`: call `POST /api/filters`
- [ ] Implement `constellation broker filters remove <filter-id>`: call `DELETE /api/filters/:id`
- [ ] Implement `constellation broker sessions list [--json]`: call `GET /api/sessions`
- [ ] Implement `constellation broker sessions revoke <session-id>`: call `DELETE /api/sessions/:id`
- [ ] Implement `constellation broker account deactivate`: call `POST /api/account/deactivate`; require typed confirmation prompt

---

## 11. Deployment

- [ ] Write broker `Dockerfile`: multi-stage build; run `prisma generate` in build stage
- [ ] Add `prisma migrate deploy` to broker container startup (not build) — applies pending migrations on deploy
- [ ] Write systemd user unit file for `constellation agent`; ship with npm package
- [ ] Write launchd `.plist` for `constellation agent`; ship with npm package
- [ ] Write Task Scheduler XML template for `constellation agent`; ship with npm package
- [ ] Write `README.md` covering broker deployment (Docker Compose), OIDC provider configuration, and agent install

---

## 12. Polish

- [ ] Verify all error taxonomy cases from plan are reachable and return correct messages
- [ ] Verify all MCP tool annotations match the annotations table in plan
- [ ] Verify `chmod 600` is documented in agent install instructions for config files
- [ ] End-to-end test: deploy broker locally, run `constellation agent init`, connect claude.ai, execute a `read_file` tool call
