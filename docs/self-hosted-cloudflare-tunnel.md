# Self-hosted with Cloudflare Tunnel

Run a Constellation relay on your own machine with a stable public HTTPS URL — no open ports, no DNS setup, no reverse proxy required.

## How it works

`cloudflared` opens an outbound connection from your machine to Cloudflare's edge. Cloudflare terminates TLS and proxies inbound HTTPS traffic to the relay running locally. A free Cloudflare account is all you need.

## Prerequisites

- Docker and Docker Compose installed
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
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
ASTERISM_ISSUER=https://auth.example.com # your asterism instance (https)
TRUST_PROXY_PRESET=cloudflare-tunnel     # already set in .env.example
```

`DATABASE_URL` isn't set directly — `docker-compose.yml` builds it from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. Make sure `POSTGRES_PASSWORD` is changed from the `.env.example` placeholder before going further.

### 4. Start the relay

```bash
docker compose up -d
```

This starts three containers: `postgres`, `relay`, and `cloudflared`.

### 5. Register the relay in asterism

In asterism, register the relay as a resource server using your tunnel URL. asterism fetches the relay's metadata at `https://relay.example.com/.well-known/oauth-protected-resource/mcp`, which declares the `relay` scope and the step-up-only `admin` scope. Add the people who should administer the relay to asterism's `constellation-admins` group. Accounts are created and managed in asterism.

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
