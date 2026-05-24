# Quick-Start Mode Plan

Reduces the barrier to entry for non-technical users by eliminating the two hardest setup requirements: an external OIDC provider and a self-managed reverse proxy. The existing "standard" configuration path is unchanged.

Priority order reflects impact-to-effort ratio.

---

## Step 1 — `AUTH_MODE=local` (Local Username/Password Auth)

### Goal

Allow the broker to run without any external OIDC provider. The broker manages its own user accounts via bcrypt-hashed passwords stored in Postgres. From the MCP client's perspective, the OAuth authorization code flow is identical — only the identity step changes.

### What changes

**Broker config**

- Add `AUTH_MODE` env var: `oidc` (default, current behavior) or `local`.
- In `local` mode, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_CALLBACK_URL` are not required and are ignored if present.

**Database**

- Add a `LocalUser` table:
  ```
  id            cuid PK
  username      text unique not null
  password_hash text not null        -- bcrypt, cost factor 12
  created_at    timestamptz not null
  last_login_at timestamptz
  is_active     boolean default true
  ```
- The existing `User` table (keyed by OIDC subject) is retained. In `local` mode a `LocalUser` row is created alongside a `User` row on first login — the `User` row is the account identity used by the rest of the system; `LocalUser` is just the credential store.

**OAuth flow modification (local mode only)**

- `GET /oauth/authorize` — instead of `302 → OIDC provider`, render a login form directly (or redirect to `/auth/login?state=...`).
- `POST /auth/login` — validates credentials against `LocalUser`, establishes a short-lived session cookie, then completes the authorization code flow (issues `code`, redirects to `redirect_uri`). The remainder of the token exchange (`POST /oauth/token`) is unchanged.
- Device code flow (`/oauth/device`) — the `/activate` page shows the same login form instead of redirecting to OIDC.
- No OIDC callback route is registered in `local` mode.

**First-run setup**

- On any request, if `AUTH_MODE=local` and no `LocalUser` rows exist, redirect to `GET /setup`.
- `GET /setup` — renders a one-time account creation form (username + password + confirm).
- `POST /setup` — creates the first `LocalUser` and the corresponding `User` row, then redirects to the originally requested URL. The setup route is disabled once any user exists (returns `410 Gone`).
- The setup page should be rate-limited (same as `/oauth/token`).

**CLI — user management**

New `constellation broker users` subcommands (require `broker:manage` token):

| Command | Description |
|---|---|
| `constellation broker users list` | List all local users (id, username, active, last login) |
| `constellation broker users add <username>` | Create a user; prompts for password |
| `constellation broker users remove <username>` | Deactivate a user (soft delete, does not destroy sessions immediately) |
| `constellation broker users reset-password <username>` | Prompts for new password; invalidates existing sessions for that user |

Password reset is CLI-only — no email/magic link in v1. This is acceptable given the single-admin use case.

**Session security**

- Login issues a `HttpOnly; Secure; SameSite=Lax` session cookie backed by a server-side session record in Postgres.
- Sessions expire after `OAUTH_ACCESS_TOKEN_TTL_HOURS` (same default: 24h) for the login step; the resulting OAuth tokens have their own TTLs unchanged.
- Brute-force protection: 5 failed login attempts per IP per 15 minutes returns `429`.

### Scope boundary

- `AUTH_MODE=local` is intentionally single-user-first. Multiple users can be added via CLI, but there is no user-facing registration flow and no role differentiation in v1.
- Multi-user RBAC is a future concern; the data model does not need to prevent it.

### Out of scope

- Email-based password reset.
- Account self-registration.
- Social login (GitHub, Google) as a separate mode — if users want that, they use `AUTH_MODE=oidc`.

---

## Step 2 — Railway One-Click Deploy Template

### Goal

A non-technical user can deploy a fully functional broker (HTTPS, public URL, Postgres) by clicking a button, without touching DNS, nginx, or TLS certificates.

### What changes

**`railway.toml`** (project root or `packages/broker/`)

- Defines the broker service and its start command.
- Sets `TRUST_PROXY` to Railway's internal proxy value automatically (Railway routes through a fixed proxy layer — the correct value needs to be confirmed against Railway's current docs, likely `true` or their CIDR range).
- References a Postgres plugin/addon.

**Railway template**

- Published to the Railway template marketplace (or as a deploy button via `railway.app/new/template/...`).
- Template defines:
  - Broker service (this repo, `packages/broker`)
  - Postgres addon (Railway-managed)
  - Required env vars surfaced as prompts: `AUTH_MODE`, and `OIDC_*` vars (shown but not required if `AUTH_MODE=local`).
  - `BROKER_URL` auto-populated from Railway's assigned domain.
  - `DATABASE_URL` auto-wired from the Postgres addon.

**README / docs**

- Add a "Deploy to Railway" badge and 5-step quick-start at the top of the README.
- Separate the quick-start path (Railway + local auth) from the self-hosted reference path.

**`fly.toml`** (secondary, lower priority)

- Equivalent configuration for Fly.io for users who prefer it.
- Fly requires more CLI ceremony than Railway; document but don't lead with it.

### TRUST_PROXY in managed environments

- Railway and Fly both terminate TLS and proxy requests. The correct `TRUST_PROXY` value differs by platform.
- Add `TRUST_PROXY_PRESET` env var with values `railway`, `fly`, `cloudflare-tunnel`, `custom`. When set, the broker resolves the correct proxy trust config automatically. `custom` falls back to reading `TRUST_PROXY` directly (existing behavior).
- This removes a footgun that would otherwise cause silent IP header spoofing misconfiguration.

### Out of scope

- Automated domain mapping (custom domain on Railway).
- Multi-region deployment.
- Autoscaling.

---

## Step 3 — First-Run Setup Wizard

### Goal

Eliminate the confusing empty state when the broker starts for the first time. Whether deployed on Railway or locally, the user lands on a guided setup page rather than a raw error or blank screen.

### What changes

**Setup detection**

- On broker startup in `AUTH_MODE=local`, check if any `LocalUser` exists. If not, set a `SETUP_REQUIRED` flag in memory.
- Any request to a non-health-check route while `SETUP_REQUIRED` is true redirects to `/setup` (except `/api/status`, which always returns normally).

**`GET /setup` — page content**

Step 1 of 1 in `AUTH_MODE=local`:

- Welcome message and brief product description.
- Form: username, password, confirm password.
- Password requirements shown inline (min 12 chars; no other complexity rules — length is sufficient).
- On submit: `POST /setup` creates the account, clears `SETUP_REQUIRED`, redirects to `/`.

In `AUTH_MODE=oidc`:

- Detect if `OIDC_*` env vars are missing or if the broker has never had a successful login.
- Show a configuration checklist with links to docs. Not an interactive form — just diagnostics and guidance.
- This is a "help you know what's wrong" page, not a setup wizard per se.

**Post-setup landing page (`GET /`)**

Currently undefined (or likely 404). Add a minimal broker status page:

- Broker version and uptime.
- Logged-in user (if session active) or login prompt.
- Quick-start instructions: how to run `constellation agent init` and how to configure the MCP client.
- Link to the management API docs.

This page serves as the "you're done, here's what to do next" screen after setup.

**MCP client config snippet**

After setup completes (or after login), display the exact JSON snippet to paste into the MCP client config, with `BROKER_URL` already filled in:

```json
{
  "mcpServers": {
    "constellation": {
      "type": "http",
      "url": "https://<broker-url>/mcp"
    }
  }
}
```

This is the single most confusing step for new users and costs nothing to automate.

### Out of scope

- Multi-step wizard (account → paths → test connection). Overkill for v1.
- Email configuration during setup.

---

## Step 4 — Cloudflare Tunnel Docker Compose Profile

### Goal

Users who want to self-host locally (not Railway) can still get a stable public HTTPS URL without configuring a reverse proxy, by adding a `cloudflared` container to the existing Docker Compose setup.

### Background

Cloudflare Tunnel (`cloudflared`) opens an outbound connection from the host to Cloudflare's edge. Cloudflare terminates TLS and proxies inbound traffic to a local port. No inbound ports, no port forwarding, no DNS management required. A free Cloudflare account is required for a named (stable) tunnel; the tunnel token is a single string.

### What changes

**`docker-compose.yml` — new `tunnel` profile**

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  restart: unless-stopped
  command: tunnel --no-autoupdate run
  environment:
    TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
  depends_on:
    - broker
  profiles:
    - tunnel
```

Run with tunnel: `docker compose --profile tunnel up`  
Run without: `docker compose up` (existing behavior, unchanged)

The `cloudflared` container proxies `https://<tunnel-name>.cfargotunnel.com → http://broker:3000`.

**`TRUST_PROXY_PRESET=cloudflare-tunnel`**

When the tunnel profile is active, `TRUST_PROXY` should be set to `127.0.0.1` (cloudflared runs in the same Compose network and forwards to localhost). The `cloudflare-tunnel` preset handles this automatically (see Step 2).

**`BROKER_URL` derivation**

- The tunnel URL is known before the broker starts (it's encoded in the `TUNNEL_TOKEN`). The broker cannot auto-detect it.
- Add a `GET /setup/tunnel-url` endpoint (setup mode only) or surface it via the setup wizard: prompt the user to enter their tunnel URL as the `BROKER_URL` value. The tunnel URL can also be found in the Cloudflare dashboard.
- Alternatively: add a `constellation broker tunnel-url` CLI command that calls the Cloudflare API (requires `CF_API_TOKEN`) to look up the tunnel URL. Lower priority — the dashboard is fine for initial setup.

**Setup flow with tunnel**

1. User creates a free Cloudflare account and a named tunnel via the Cloudflare dashboard (guided in docs — ~5 minutes).
2. User copies the tunnel token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. User copies the tunnel URL into `.env` as `BROKER_URL`.
4. `docker compose --profile tunnel up` starts broker + cloudflared.
5. First-run setup wizard (Step 3) handles the rest.

**Docs**

- Add a "Self-hosted with Cloudflare Tunnel" setup guide.
- Keep it separate from the Railway path — don't conflate them.
- Include a prerequisites checklist: Docker, Cloudflare account, 10 minutes.

### Alternatives considered and rejected

- **ngrok**: Free tier has ephemeral URLs and session time limits. Not viable for a persistent agent broker.
- **Tailscale Funnel**: Requires Tailscale on both the host and every machine running an MCP client. Too constraining.
- **localtunnel / localhost.run**: Unreliable, not production-grade.

### Out of scope

- Automatic tunnel creation via the Cloudflare API.
- Tunnel health monitoring / alerting.
- Multiple tunnel endpoints (e.g. separate tunnel per service).

---

## Summary

| Step | Removes | Adds | Effort |
|---|---|---|---|
| 1 — Local auth | OIDC provider requirement | `AUTH_MODE=local`, login form, user CLI | Medium |
| 2 — Railway template | Reverse proxy + TLS + hosting setup | `railway.toml`, deploy button, `TRUST_PROXY_PRESET` | Low–Medium |
| 3 — Setup wizard | Confusing empty state | First-run page, post-setup snippet | Low |
| 4 — CF Tunnel Compose | Need for open inbound ports or proxy | `cloudflared` profile, tunnel docs | Low |

Steps 1 and 2 are the highest leverage. Steps 3 and 4 complete the experience but have no bearing on whether the system works — they reduce friction on the path to working.

Dependencies: Step 3 (setup wizard) depends on Step 1 existing (`AUTH_MODE=local` mode is what makes the wizard meaningful). Steps 2 and 4 are independent of each other and of Step 1, but all benefit from `TRUST_PROXY_PRESET` being implemented once.
