# Shared Agent Quick Start

A shared agent runs as a system service on a multi-user machine (dev server, NAS, domain host) and dispatches each tool call under the requesting user's OS identity. Users connect through the same broker they already use — no per-user agent setup required on the shared machine.

> **Local auth mode is not supported.** Shared agents require `AUTH_MODE=oidc` on the broker. The built-in local username/password mode does not provide the stable identity claims needed to resolve a broker user to a local OS account.

---

## Prerequisites

- Linux with systemd
- A running broker configured with `AUTH_MODE=oidc`
- The `constellation` binary installed on the shared machine (`sudo dpkg -i constellation-agent_*_amd64.deb`)
- A dedicated low-privilege service account (e.g. `constellation`)
- Your OIDC provider configured to forward a user attribute as a claim — see [Identity resolution](#identity-resolution)

---

## 1. Create the service account

```sh
sudo useradd --system --no-create-home --shell /sbin/nologin constellation
```

The account needs `CAP_SETUID` and `CAP_SETGID` to drop privileges into each user's identity. These are granted via the systemd unit (step 5). The service will refuse to start if run as root.

---

## 2. Promote your first admin

The shared agent registration flow (step 3) requires an admin to approve it in the browser. Before that can happen, at least one broker user must have the admin role.

On a fresh broker, set `BROKER_ADMIN_TOKEN=<your-token>` in your broker's environment variables before deploying:

```sh
# On the machine running the broker CLI (must have BROKER_ADMIN_TOKEN set):
BROKER_ADMIN_TOKEN=<your-token> constellation broker user promote <oidc-sub>
```

The OIDC subject identifier (`sub`) for a user can be found in your OIDC provider's user directory. Once you have at least one admin, future promotions can be done through the web UI or with `constellation broker elevate` + `constellation broker user promote`.

> **Remove `BROKER_ADMIN_TOKEN` from the broker environment after bootstrapping and restart the broker.** Leaving it set keeps a permanent unauthenticated admin API active.

---

## 3. Register with the broker

```sh
sudo constellation shared-agent register \
  --broker-url https://broker.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/shared-agent.env
```

A browser opens for admin approval. The token is written to `/etc/constellation/shared-agent.env` and never printed to the terminal.

```sh
sudo chown constellation:constellation /etc/constellation/shared-agent.env
sudo chmod 600 /etc/constellation/shared-agent.env
```

---

## 4. Write the config file

```yaml
# /etc/constellation/shared-agent.yaml

broker_url: wss://broker.example.com
agent_name: nas-shared
audit_log: /var/log/constellation/shared-agent-audit.jsonl
env_file: /etc/constellation/shared-agent.env

labels:
  - name: projects
    path: /srv/projects
    permissions:
      default: read-write

identity:
  claims:
    - constellation_username   # OIDC claim your provider forwards — see below
```

Set ownership:
```sh
sudo chown constellation:constellation /etc/constellation/shared-agent.yaml
sudo chmod 600 /etc/constellation/shared-agent.yaml
sudo mkdir -p /var/log/constellation
sudo chown constellation:constellation /var/log/constellation
```

---

## 5. Identity resolution

The agent resolves a broker user to a local OS account using this priority chain:

1. **OIDC claims** (recommended) — configure your provider to forward a stable user attribute as a custom claim, then list those claim names under `identity.claims`. With Authentik, add a Property Mapping that forwards the `uid` directory attribute as a claim named `constellation_username`, then add that claim to your provider.

2. **Explicit map** — if custom claims aren't available, map each user's OIDC subject identifier to a local username:
   ```yaml
   identity:
     user_map:
       - oidc_sub: "auth0|abc123"
         local_username: alice
   ```

3. **`preferred_username`** (opt-in, disabled by default) — risky on most providers; only enable if your provider locks this claim:
   ```yaml
   identity:
     allow_preferred_username: true
   ```

---

## 6. Generate and install the systemd unit

```sh
sudo constellation shared-agent install \
  --config /etc/constellation/shared-agent.yaml \
  --user constellation \
  | sudo tee /etc/systemd/system/constellation-shared-agent.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now constellation-shared-agent
```

---

## 7. Verify

```sh
sudo systemctl status constellation-shared-agent
sudo journalctl -u constellation-shared-agent -f
```

Once connected the agent appears as online in `list_hosts`. Run `constellation shared-agent validate-config --config /etc/constellation/shared-agent.yaml` to check config before restarting.

---

## What's next

- **Access control** — restrict which broker users can access a label, or grant read-only access to specific users. See [docs/shared-agent.md §4](docs/shared-agent.md#4-permission-model).
- **UID range restrictions** — block system accounts from being impersonated. See [docs/shared-agent.md §5](docs/shared-agent.md#5-deployment) (`subagent_uid`).
- **Token rotation** — `constellation shared-agent rotate-token --config /etc/constellation/shared-agent.yaml`
- **Full reference** — [docs/shared-agent.md](docs/shared-agent.md)
