# Hub Quick Start

A hub runs as a system service on a multi-user machine (dev server, NAS, domain host) and dispatches each tool call under the requesting user's OS identity. Users connect through the same relay they already use — no per-user node setup required on the shared machine.

> **Local auth mode is not supported.** Hubs require `AUTH_MODE=oidc` on the relay. The built-in local username/password mode does not provide the stable identity claims needed to resolve a relay user to a local OS account.

---

## Prerequisites

- Linux with systemd
- A running relay configured with `AUTH_MODE=oidc`
- The `constellation` binary installed on the shared machine (`sudo dpkg -i constellation-node_*_amd64.deb`)
- A dedicated low-privilege service account (e.g. `constellation`)
- Your OIDC provider configured to forward a user attribute as a claim — see [Identity resolution](#identity-resolution)

---

## 1. Create the service account

```sh
sudo useradd --system --no-create-home --shell /sbin/nologin constellation
```

The account needs `CAP_SETUID` and `CAP_SETGID` to drop privileges into each user's identity. These are granted via the systemd unit (step 6). The service will refuse to start if run as root.

---

## 2. Promote your first admin

The hub registration flow (step 3) requires an admin to approve it in the browser. Before that can happen, at least one relay user must have the admin role.

On a fresh relay, set `RELAY_ADMIN_TOKEN=<your-token>` in your relay's environment variables before deploying:

```sh
# On the machine running the relay CLI (must have RELAY_ADMIN_TOKEN set):
RELAY_ADMIN_TOKEN=<your-token> constellation relay user promote <oidc-sub>
```

The OIDC subject identifier (`sub`) for a user can be found in your OIDC provider's user directory. Once you have at least one admin, future promotions can be done through the web UI or with `constellation relay elevate` + `constellation relay user promote`.

> **Remove `RELAY_ADMIN_TOKEN` from the relay environment after bootstrapping and restart the relay.** Leaving it set keeps a permanent unauthenticated admin API active.

---

## 3. Register with the relay

```sh
sudo constellation hub register \
  --relay-url https://relay.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/hub.env
```

A browser opens for admin approval. The token is written to `/etc/constellation/hub.env` and never printed to the terminal.

```sh
sudo chown constellation:constellation /etc/constellation/hub.env
sudo chmod 600 /etc/constellation/hub.env
```

---

## 4. Write the config file

```yaml
# /etc/constellation/hub.yaml

relay_url: wss://relay.example.com
hub_name: nas-shared
audit_log: /var/log/constellation/hub-audit.jsonl
env_file: /etc/constellation/hub.env

shares:
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
sudo chown constellation:constellation /etc/constellation/hub.yaml
sudo chmod 600 /etc/constellation/hub.yaml
sudo mkdir -p /var/log/constellation
sudo chown constellation:constellation /var/log/constellation
```

---

## 5. Identity resolution

The hub resolves a relay user to a local OS account using this priority chain:

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
sudo constellation hub install \
  --config-file /etc/constellation/hub.yaml \
  --user constellation \
  | sudo tee /etc/systemd/system/constellation-hub.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now constellation-hub
```

---

## 7. Verify

```sh
sudo systemctl status constellation-hub
sudo journalctl -u constellation-hub -f
```

Once connected the hub appears as online in `list_hosts`. Run `constellation hub validate-config --config-file /etc/constellation/hub.yaml` to check config before restarting.

---

## What's next

- **Access control** — restrict which relay users can access a share, or grant read-only access to specific users. See [docs/hub.md §4](docs/hub.md#4-permission-model).
- **UID range restrictions** — block system accounts from being impersonated. See [docs/hub.md §5](docs/hub.md#5-deployment) (`subnode_uid`).
- **Token rotation** — `constellation hub rotate-token --config-file /etc/constellation/hub.yaml`
- **Full reference** — [docs/hub.md](docs/hub.md)
