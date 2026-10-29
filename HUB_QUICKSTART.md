# Hub Quick Start

A hub runs as a system service on a multi-user machine (dev server, NAS, domain host) and dispatches each tool call under the requesting user's OS identity. Users connect through the same relay they already use — no per-user node setup required on the shared machine.

> **Hubs need asterism.** The hub resolves a relay user to a local OS account from the asterism access token (`sub`, `groups` and the `constellation_username` claim). A relay without asterism cannot supply those.

---

## Prerequisites

- Linux with systemd
- A running relay configured to use [asterism](https://github.com/Mahasamuha/asterism-proxy) as its authorization server, with asterism federated to an OIDC identity provider (for example Authentik). asterism's local accounts carry no groups or claims, so they can neither approve a hub nor map to an OS account by claim. See [Running asterism](docs/configuration.md#running-asterism)
- The `constellation` binary installed on the shared machine (`sudo dpkg -i constellation-cli_*_amd64.deb`)
- A dedicated low-privilege service account (e.g. `constellation`)
- asterism configured to release a user attribute as the `constellation_username` claim — see [Identity resolution](#identity-resolution)

---

## 1. Create the service account

```sh
sudo useradd --system --no-create-home --shell /sbin/nologin constellation
```

The account needs `CAP_SETUID` and `CAP_SETGID` to drop privileges into each user's identity. These are granted via the systemd unit (step 6). The service will refuse to start if run as root.

---

## 2. Make sure an admin can approve the hub

Hub registration needs an access token with the `admin` scope. asterism grants that scope only to members of the `constellation-admins` group, and only on a step-up sign-in. There is nothing to configure on the relay: add the account that will approve the hub to `constellation-admins` in your identity provider (for example Authentik), so asterism sees the membership.

The relay checks the group itself (`ADMIN_GROUP`, default `constellation-admins`) as well as the `admin` scope, so the account must be in that group even if asterism's scope policy was never set. On the asterism side, release the claims the hub uses and restrict the scope, before users connect. Run these from the compose project that runs asterism (the relay's `docker/standard/` or `docker/cloudflare-tunnel/` if you use the bundled `asterism` profile):

```sh
docker compose exec asterism-proxy asterism-cli resource-server approve <relay-url>/mcp \
  --name Constellation --release-claims groups,email,constellation_username
docker compose exec asterism-proxy asterism-cli resource-server policy <relay-url>/mcp admin \
  --short-lived --require-groups constellation-admins
```

Grants made before the claims were released carry no `groups` or `constellation_username` until the user re-consents; revoke them in asterism's `/grants`.

> **Warning.** `groups` and `constellation_username` are only as trustworthy as their upstream source. asterism's `OIDC_CLAIM_MAP` must never map them onto a claim users can edit (`preferred_username`, `name`, `nickname`, `email`, ...), and the identity provider attribute behind `constellation_username` must be admin-only and unique per user. asterism does not enforce this; if it is wrong, users can pick their OS account or join groups. See [Configuration](docs/configuration.md#operator-runbook-configure-asterism-before-users-connect).

The approving person is whoever signs in at step 3. They do not have to be the person running the command, but they must be in the group; otherwise the sign-in is denied and `hub register` exits with "Access denied".

---

## 3. Register with the relay

```sh
sudo constellation hub register \
  --relay https://relay.example.com \
  --host-name nas-shared \
  --env-file /etc/constellation/hub.env
```

A browser opens for an admin sign-in (scopes `relay admin register`). Registering needs a fresh sign-in, so the admin is asked for their password even if already signed in. The token is written to `/etc/constellation/hub.env` and never printed to the terminal.

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
    - constellation_username   # claim asterism releases — see below
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

1. **Claims** (recommended) — asterism releases a `constellation_username` claim for each user; list it under `identity.claims`. The value must be the exact name of an account on the hub host (case-sensitive; `user@domain.example` is fine for SSSD). A numeric, padded or otherwise malformed value, or a name that does not resolve to exactly that account, is refused outright: the hub does not fall back to the explicit map. Only a user with **no** such claim reaches step 2.

2. **Explicit map** — if the claim isn't available for a user, map their asterism `sub` (their Constellation user id) to a local username:
   ```yaml
   identity:
     user_map:
       - sub: "4f1c2a9e-0000-0000-0000-000000000000"
         local_username: alice
   ```

There is no `preferred_username` fallback; `identity.allow_preferred_username` was removed and a config that sets it fails to load. A config using `oidc_sub` anywhere (in `user_map` or in share `permissions.overrides`) also fails to load: re-key those entries to `sub`, or in overrides to `group`.

### Per-share overrides

Share permissions can name a user by `sub` or a group by name (from the token's `groups` claim):

```yaml
shares:
  - name: projects
    path: /srv/projects
    permissions:
      default: none
      overrides:
        - group: engineering
          access: read-write
        - sub: "4f1c2a9e-0000-0000-0000-000000000000"
          access: read-only
```

A `sub` entry wins outright; otherwise the most permissive matching `group` entry applies; otherwise the default.

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
