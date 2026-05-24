# Quick-Start Mode — Implementation Checklist

## Prerequisites / Shared Infrastructure

- [x] **`TRUST_PROXY_PRESET`** — `packages/broker/src/app.ts`
  - [x] Replace `TRUST_PROXY` block with preset-first logic
    - `railway` → `app.set("trust proxy", true)`
    - `fly` → `app.set("trust proxy", 1)`
    - `cloudflare-tunnel` → `app.set("trust proxy", "127.0.0.1")`
    - unset → fall through to existing `TRUST_PROXY` raw string (keep current validation)
- [x] **`GET /healthz`** — `packages/broker/src/app.ts`
  - [x] Add unauthenticated `{ status: "ok" }` endpoint for Railway/Fly health checks

---

## Step 1 — `AUTH_MODE=local`

### A. Schema migration `0003_local_auth`

- [x] `packages/broker/prisma/schema.prisma`
  - [x] Make `User.oidcSub` nullable
  - [x] Make `User.oidcIssuer` nullable
  - [x] Add `LocalUser` model with `id`, `username`, `passwordHash`, `createdAt`, `lastLoginAt`, `isActive`, `userId` (FK → User)
  - [x] Add `localUser LocalUser?` back-relation to `User`
- [x] Create `packages/broker/prisma/migrations/0003_local_auth/migration.sql`
  - [x] `ALTER COLUMN oidc_sub DROP NOT NULL`
  - [x] `ALTER COLUMN oidc_issuer DROP NOT NULL`
  - [x] `CREATE TABLE local_users (...)`
- [x] Run `prisma generate` to regenerate client

### B. New file: `packages/broker/src/local-auth.ts`

- [x] Add `bcryptjs` + `@types/bcryptjs` to `packages/broker/package.json`
- [x] `createLocalUser(username, password)` — bcrypt hash (cost 12), create `LocalUser` + `User` in transaction
- [x] `validateLocalUser(username, password)` — returns `User.id` or throws; updates `lastLoginAt`
- [x] In-memory brute-force map: 5 failures / IP / 15 min → caller returns 429
- [x] `checkBruteForce(ip)` / `recordFailure(ip)` helpers
- [x] `pruneLoginFailures()` — exported for periodic cleanup

### C. Modify `packages/broker/src/oauth.ts`

- [x] `GET /oauth/authorize` — branch on `AUTH_MODE`
  - [x] In `local` mode: store OAuth params in `login_pending_<id>` cookie (`clientId`, `redirectUri`, `codeChallenge`, `codeChallengeMethod`, `downstreamState`); redirect to `GET /auth/login?pending=<id>`
  - [x] In `oidc` mode: existing behavior unchanged
- [x] Add `GET /auth/login` — render login form; pass `pending` query param through as hidden field
- [x] Add `POST /auth/login`
  - [x] Check brute force; return 429 if exceeded
  - [x] Validate credentials via `validateLocalUser`
  - [x] On failure: re-render form with error, call `recordFailure(ip)`
  - [x] On success: read `login_pending_<id>` cookie, issue auth code into existing `authCodes` map, redirect to `redirect_uri`
- [x] No `/oauth/callback` route registered in `local` mode

### D. Modify `packages/broker/src/device.ts`

- [x] `GET /activate?user_code=XXX` — in `local` mode
  - [x] After validating user code, render `localActivateLoginPage(deviceCode)` HTML instead of redirecting to OIDC
- [x] Add `POST /activate/login`
  - [x] Check brute force; return 429 if exceeded
  - [x] Validate credentials via `validateLocalUser`
  - [x] On failure: re-render login form with error, call `recordFailure(ip)`
  - [x] On success: set `entry.pendingUserId`; render existing `consentPage()`
- [x] No `/activate/callback` route registered in `local` mode
- [x] Add `localActivateLoginPage(deviceCode, error?)` HTML helper

### E. New file: `packages/broker/src/setup.ts`

- [x] `setupRequired()` — checks `AUTH_MODE=local` and `LocalUser` count is 0; cache result after first user exists
- [x] `setupMiddleware` — redirect to `/setup` when setup required (skip `/setup`, `/healthz`, `/api/status`)
- [x] `GET /setup`
  - [x] In `local` mode: welcome message + account creation form (username, password, confirm; min 12 chars enforced client-side and server-side)
  - [x] In `oidc` mode: configuration checklist (missing env vars, OIDC discovery status)
  - [x] Return `410 Gone` once any user exists
- [x] `POST /setup` — call `createLocalUser()`, redirect to `/`
- [x] Rate-limit `/setup` with existing `oauthLimiter`
- [x] `GET /` — broker landing page
  - [x] Broker version + uptime
  - [x] Auth mode indicator
  - [x] MCP client config JSON snippet with `BROKER_URL` pre-filled
  - [x] "Next: run `constellation agent init --broker <url>`" instructions

### F. User management API routes — `packages/broker/src/api.ts`

All routes require `requireBrokerManage` and `AUTH_MODE=local`:

- [x] `GET /api/users` — list all local users (id, username, isActive, lastLoginAt)
- [x] `POST /api/users` — `{ username, password }` → create user via `createLocalUser()`
- [x] `DELETE /api/users/:username` — soft-deactivate (`isActive = false`, also set `User.deactivatedAt`)
- [x] `POST /api/users/:username/reset-password` — `{ password }` → rehash + expire all `OauthSession` rows for that user

### G. App wiring — `packages/broker/src/app.ts`

- [x] Import and mount `setupRouter`
- [x] Apply `setupMiddleware` before other routers

### H. Index wiring — `packages/broker/src/index.ts`

- [x] Import `pruneLoginFailures` from `local-auth.ts`
- [x] Add to the existing 5-minute prune interval

### I. CLI commands — `packages/agent/src/cli/broker.ts`

- [x] Add `broker.command("users")` subcommand group
  - [x] `users list` — `GET /api/users`, tabular output
  - [x] `users add <username>` — prompt for password (stdin, no echo), `POST /api/users`
  - [x] `users remove <username>` — confirm prompt, `DELETE /api/users/:username`
  - [x] `users reset-password <username>` — prompt for new password, `POST /api/users/:username/reset-password`

---

## Step 3 — Setup Wizard

Covered by Step 1E. Additional item:

- [x] `GET /` landing page — verify `BROKER_URL` is correctly included in the MCP snippet
- [x] Confirm `410 Gone` is returned on `GET /setup` once any user exists

---

## Step 2 — Railway Template

- [x] Create `packages/broker/railway.toml`
  - [x] Builder: Dockerfile at `packages/broker/Dockerfile`
  - [x] Health check path: `/healthz`
  - [x] Surface `AUTH_MODE`, `OIDC_*` (optional if `AUTH_MODE=local`), `BROKER_URL`, `DATABASE_URL` as template vars
- [x] Create `packages/broker/fly.toml`
  - [x] Equivalent config for Fly.io
  - [x] Internal port 3000, health check `/healthz`
- [x] Update `README.md`
  - [x] "Deploy to Railway" badge at top
  - [x] 5-step quick-start section (Railway + local auth path)
  - [x] Separate from existing self-hosted reference path

---

## Step 4 — Cloudflare Tunnel Compose Profile

- [x] Add `cloudflared` service to `docker-compose.yml` under `tunnel` profile
- [x] Add `CLOUDFLARE_TUNNEL_TOKEN=` and `TRUST_PROXY_PRESET=` to `.env.example`
- [x] Create `docs/self-hosted-cloudflare-tunnel.md`
  - [x] Prerequisites checklist: Docker, Cloudflare account, 10 min
  - [x] Step-by-step: create tunnel in dashboard → copy token → set `BROKER_URL` → `docker compose --profile tunnel up`
  - [x] Note that tunnel URL is known before broker starts (encoded in token / visible in CF dashboard)
