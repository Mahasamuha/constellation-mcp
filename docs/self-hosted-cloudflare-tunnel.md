# Self-hosted with Cloudflare Tunnel

Run a Constellation relay on your own machine with a stable public HTTPS URL — no open ports, no DNS setup, no reverse proxy required.

## How it works

`cloudflared` opens an outbound connection from your machine to Cloudflare's edge. Cloudflare terminates TLS and proxies inbound HTTPS traffic to the relay running locally. A free Cloudflare account is all you need.

## Prerequisites

- Docker and Docker Compose installed
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- An [asterism](https://github.com/Mahasamuha/asterism-proxy) authorization server for sign-in, either one you already run or the one bundled in this compose project ([below](#optional-run-asterism-in-the-same-compose-project)), plus an OIDC identity provider such as Authentik if you need admins, hubs or group-based access (see [Running asterism](configuration.md#running-asterism))
- ~10 minutes

## Setup

### 1. Create a Cloudflare Tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks** → **Tunnels**
2. Click **Create a tunnel** → choose **Cloudflared**
3. Give it a name (e.g. `constellation`)
4. On the **Install connector** step, copy the token string shown in the `--token` flag — you'll need it in step 3

### 2. Configure the tunnel route

In the tunnel's **Public Hostname** tab, add a route:

| Field | Value |
|---|---|
| Subdomain | anything (e.g. `relay`) |
| Domain | your Cloudflare-managed domain |
| Service type | `HTTP` |
| URL | `localhost:3000` |

Your tunnel URL will be `https://<subdomain>.<domain>` (e.g. `https://relay.example.com`).

**Why `localhost:3000` and not `relay:3000`:** the `cloudflared` container in this Compose file runs with `network_mode: service:relay`, sharing the relay container's network namespace. This makes cloudflared's connection to the relay arrive from `127.0.0.1`, which the relay needs in order to trust Cloudflare's forwarded client-IP headers (see `TRUST_PROXY_PRESET` below). Pointing the route at `relay:3000` instead would connect over the Docker bridge network rather than loopback, defeating that trust relationship and collapsing rate limiting onto a single shared IP for all users.

### 3. Configure environment variables

```bash
cd docker/cloudflare-tunnel
cp .env.example .env
```

Fill in the required values:

```
RELAY_URL=https://relay.example.com      # your tunnel URL from step 2
CLOUDFLARE_TUNNEL_TOKEN=<paste token>    # from step 1
POSTGRES_PASSWORD=<replace with a strong password>   # .env.example ships a placeholder — change it
ASTERISM_ISSUER=https://auth.example.com # your asterism instance (https, its own hostname)
TRUST_PROXY_PRESET=cloudflare-tunnel     # already set in .env.example
```

`DATABASE_URL` isn't set directly — `docker-compose.yml` builds it from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Make sure `POSTGRES_PASSWORD` is changed from the `.env.example` placeholder before going further.

### Optional: run asterism in the same compose project

Skip this if you already run asterism elsewhere.

1. In the tunnel's **Public Hostname** tab, add a second route for asterism: the host of `ASTERISM_ISSUER` (e.g. `auth.example.com`), service type `HTTP`, URL `asterism-proxy:3000`. asterism publishes no host port; cloudflared reaches it over the compose network.
2. In `.env`, uncomment `COMPOSE_PROFILES=asterism`.
3. Copy and fill in asterism's settings:

   ```bash
   cp asterism.env.example asterism.env
   ```

   Set `COOKIE_SECRET` (`openssl rand -hex 32`), change the database password in both `POSTGRES_PASSWORD` and `DATABASE_URL`, and configure your identity provider (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). Leave `TRUST_PROXY=1`. asterism's issuer is taken from `ASTERISM_ISSUER` in `.env`.

### 4. Start the relay

```bash
docker compose up -d
```

This starts three containers: `postgres`, `relay`, and `cloudflared`, plus `asterism-proxy` and `asterism-postgres` with the `asterism` profile.

### 5. Register the relay in asterism

Register the relay as a resource server using your tunnel URL, release the claims Constellation uses and restrict the `admin` scope, before anyone connects. With the bundled asterism, run from this directory:

```bash
docker compose exec asterism-proxy asterism-cli resource-server approve https://relay.example.com/mcp \
  --name Constellation --release-claims groups,email,constellation_username
docker compose exec asterism-proxy asterism-cli resource-server policy https://relay.example.com/mcp admin \
  --short-lived --require-groups constellation-admins
```

asterism fetches the relay's metadata at `https://relay.example.com/.well-known/oauth-protected-resource/mcp`, which declares the `relay` scope and the fresh-sign-in-only `admin` and `register` scopes. Add the people who should administer the relay to the `constellation-admins` group in your identity provider; asterism copies groups from there. Read the warnings in the [operator runbook](configuration.md#operator-runbook-configure-asterism-before-users-connect) before going further.

## Updating

```bash
cd docker/cloudflare-tunnel
# 1. Edit docker-compose.yml and bump the image tag to the new release version:
#    image: mahasamuha/constellation-relay:<new-version>
docker compose pull
docker compose up -d
```

For backup and restore guidance — and what to expect after restoring an
older backup — see [docs/operations.md](operations.md).

## Troubleshooting

**Tunnel not connecting** — check the `cloudflared` logs: `docker compose logs cloudflared`

**`TRUST_PROXY_PRESET` note** — when running with the tunnel profile, set `TRUST_PROXY_PRESET=cloudflare-tunnel`. This configures Express to trust the single proxy hop from the `cloudflared` container. Do not set a raw `TRUST_PROXY` value alongside this.
