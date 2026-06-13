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
| URL | `relay:3000` |

Your tunnel URL will be `https://<subdomain>.<domain>` (e.g. `https://relay.example.com`).

### 3. Configure environment variables

```bash
cd docker/cloudflare-tunnel
cp .env.example .env
```

Fill in the required values:

```
RELAY_URL=https://relay.example.com      # your tunnel URL from step 2
CLOUDFLARE_TUNNEL_TOKEN=<paste token>    # from step 1
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/constellation
AUTH_MODE=local                          # or oidc if you have a provider
TRUST_PROXY_PRESET=cloudflare-tunnel     # already set in .env.example
```

### 4. Start the relay

```bash
docker compose up -d
```

This starts three containers: `postgres`, `relay`, and `cloudflared`.

### 5. Complete setup

Open your tunnel URL in a browser. The first-run setup wizard will guide you through creating your admin account.

## Updating

```bash
cd docker/cloudflare-tunnel
docker compose pull
docker compose up -d
```

## Troubleshooting

**Tunnel not connecting** — check the `cloudflared` logs: `docker compose logs cloudflared`

**`TRUST_PROXY_PRESET` note** — when running with the tunnel profile, set `TRUST_PROXY_PRESET=cloudflare-tunnel`. This configures Express to trust the single proxy hop from the `cloudflared` container. Do not set a raw `TRUST_PROXY` value alongside this.
