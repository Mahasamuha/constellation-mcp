# Operations

Backup, restore, log rotation, and upgrade guidance for running a relay in
production. Constellation isn't opinionated about *how* you back anything up —
use whatever mechanism already fits your infrastructure. This page is about
*what* needs backing up, *why*, and what self-heals on its own without one.

- [Backing up the relay database](#backing-up-the-relay-database)
- [What a database backup does and doesn't cover](#what-a-database-backup-does-and-doesnt-cover)
- [Backing up node and hub configuration](#backing-up-node-and-hub-configuration)
- [Restoring](#restoring)
- [Upgrading](#upgrading)
- [Log rotation](#log-rotation)

## Backing up the relay database

Postgres is the relay's only durable store — users, executor tokens, path
shares, deny filters, and the activity log all live
there. There's no Redis, no second datastore, nothing else to back up on the
relay side.

How you back it up depends on how you're running Postgres:

- **Managed Postgres (Railway, Fly Postgres, RDS, etc.)** — use the
  provider's own backup/snapshot feature. This is almost always the easiest
  option if you deployed that way; there's nothing Constellation-specific to
  configure.
- **Self-hosted (`docker/standard/`, `docker/cloudflare-tunnel/`)** — either
  `pg_dump` the database on a schedule, or snapshot the `pgdata` Docker
  volume directly. A `pg_dump` is the simpler starting point:

  ```bash
  docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "constellation-$(date +%F).sql.gz"
  ```

  Run that on whatever schedule matches your tolerance for lost activity
  (daily is reasonable for most deployments), and copy the dump somewhere
  other than the same disk as the volume — a backup that lives next to what
  it's backing up doesn't survive the failure you're protecting against.

There's no special restore step required beyond standard Postgres
restore — see [Restoring](#restoring) below for what to expect afterward.

## What a database backup does and doesn't cover

Not everything in Postgres is *only* in Postgres. Worth knowing which is
which before you decide how aggressively to back it up:

**Recoverable without a backup, because the authoritative copy lives elsewhere:**

- **Path shares and hub shares** — the relay's copy is always a cache of
  what the node or hub last pushed via `config_update`/`hub_share_sync`; the
  node's `paths.yaml` and the hub's `hub.yaml` are the actual source of
  truth (see [Design Philosophy](architecture.md#design-philosophy)). If the
  relay's database is restored from an older backup, or lost outright and
  rebuilt empty, every node and hub just needs to reconnect — its existing
  local config gets pushed again on the next `config_update`, and the
  share/path list is back exactly as it was. Nothing about your share
  definitions needs to be remembered or recreated by hand.

**Not recoverable without a backup — these have no copy outside Postgres:**

- **Executor tokens** — re-registering (`constellation node init` /
  `constellation hub register`) issues a fresh one; this is true with or
  without a database backup, since a token that isn't in the database isn't
  valid regardless of what's on disk. Not a backup gap, just worth knowing
  re-registration is always part of recovering a node/hub's connection.
- **Relay path filters** (deny filters) — these exist only as
  `relay_path_filters` rows. If lost, they're gone; there's no node- or
  hub-side copy to fall back on. If you rely on filters for anything
  important, make sure your backup cadence reflects that.
- **Accounts, groups and admin membership** — these live in asterism, not
  the relay. Back up asterism's own database. The relay's `users` table holds
  only ids; a lost row is recreated the next time that user's token is seen,
  but their executors, shares and filters are gone with the backup gap.
- **Activity log** — historical audit data only; losing it has no functional
  effect on the running system, but it does mean losing whatever audit trail
  you had before the backup.
- **Sessions and grants** — these live in asterism and are part of its
  backup. The relay stores no tokens or sessions.

## Backing up node and hub configuration

Node config (`~/.config/constellation/` on Linux/macOS,
`%APPDATA%\constellation\` on Windows — see
[Config](architecture.md#config)) and hub config (the `hub.yaml` path the
operator chose, plus its `env_file`) don't need any Constellation-specific
backup procedure. Back them up the same way you'd back up the rest of that
machine's configuration — whatever your normal server or desktop backup
routine already covers for that host is sufficient.

Worth being clear about *why* this matters, since it's a different reason
than the database backup above: it's not for the relay's sake — as covered
in the previous section, the relay can always recover share definitions from
a connected node or hub regardless of what's in its own database. It's for
*that machine's* sake — if the laptop or server itself is lost, reimaged, or
its disk fails, `paths.yaml`/`hub.yaml` is the only record of exactly which
paths were shared, under what names, with what instructions. Back it up so
you don't have to reconstruct that list from memory, not because Constellation
needs you to.

## Restoring

1. Stop the relay (`docker compose stop relay` or equivalent).
2. Restore the Postgres data — either replace the `pgdata` volume's contents
   from a volume-level snapshot, or restore a `pg_dump`:
   ```bash
   gunzip -c constellation-2026-06-01.sql.gz | docker compose exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB"
   ```
3. Start the relay. Migrations apply automatically on every start (see
   README), so a restored database gets brought up to the current schema
   without a separate migration step — there's nothing additional to run.
4. Expect drift relative to the moment the backup was taken: anything
   created after that point (new users, new tokens, new filters) is gone.
   Any node or hub whose token was rotated *after* the backup was taken will
   fail to reconnect — the token it currently holds was issued after the
   backup, so the restored database has no record of it at all. Re-register
   it (`constellation node init` / `constellation hub register`) to issue a
   token the restored database actually knows about. Nodes/hubs that haven't
   rotated since the backup reconnect normally with no action needed.

## Upgrading

```bash
cd docker/standard   # or docker/cloudflare-tunnel
# 1. Edit docker-compose.yml and bump the image tag to the new release version:
#    image: mahasamuha/constellation-relay:<new-version>
docker compose pull
docker compose up -d
```

Migrations apply automatically on every start, so beyond bumping the tag this is the entire
procedure for routine updates — no manual migration step. As with any
schema change, taking a fresh backup immediately before pulling a new image
is cheap insurance, particularly across a large version jump; check the
relay's changelog/migration history for that range if you're skipping
several releases at once.

Upgrade notes for the move to asterism as the authorization server
([ADR 0022](adr/0022-asterism-authorization-server.md)):

- Set `ASTERISM_ISSUER` (an `https:` URL) and make sure `RELAY_URL` is a bare
  origin, or the relay fails at startup. Remove `AUTH_MODE`, `OIDC_*`,
  `COOKIE_SECRET`, `ADMIN_GROUPS`, `ADMIN_SESSION_DURATION`,
  `RELAY_ADMIN_TOKEN` and the `OAUTH_*` and OAuth/device rate-limit settings;
  they are ignored.
- Register the relay in asterism as a resource server, and put administrators
  in asterism's `constellation-admins` group. Constellation also enforces the
  group itself (`ADMIN_GROUP`, default `constellation-admins`): an admin needs
  the `admin` scope and that group.
- Configure asterism before users connect (full commands and warnings in
  [Configuration](configuration.md#operator-runbook-configure-asterism-before-users-connect)):
  `asterism-cli resource-server approve <relay-url>/mcp --release-claims groups,email,constellation_username`,
  then `asterism-cli resource-server policy <relay-url>/mcp admin --short-lived --require-groups constellation-admins`.
  Grants made before the claims were released carry no `groups` or
  `constellation_username` until the user re-consents; revoke them in asterism
  (`/grants`).
- **Trust the claim sources.** `groups` and `constellation_username` are only
  as trustworthy as their upstream source. asterism's `OIDC_CLAIM_MAP` must
  never map them onto a user-editable claim (`preferred_username`, `name`,
  `nickname`, `email`, ...), and the identity provider attribute behind
  `constellation_username` must be admin-only and unique per user. asterism
  does not enforce this; a misconfiguration lets users choose their OS account
  on a hub or join groups.
- Group overrides on a share use the most permissive matching group, so a group
  set to `none` is not a denylist; deny by `sub`, or use `default: none` plus
  grants. A `groups` claim over 4096 characters is dropped by asterism, so keep
  group lists small.
- `RELAY_URL` must be `https:` (`http:` only on loopback). Migration
  `0007_hub_host_unique` adds a unique index on user-less (hub) executors by
  host and fails if two hub executors already share a host; delete the stale
  row first. Host names are now limited to 1-63 characters of letters, digits,
  `.`, `_` and `-`; existing names outside that set keep working until renamed.
- Take a database backup first. Migration `0006_asterism_resource_server`
  drops the OAuth server tables (`auth_codes`, `device_codes`, `oauth_clients`,
  `oauth_sessions`, `local_users`, `login_failures`) and the email, role and
  OIDC identity columns of `users`. Existing `users.id` values are kept, so
  executors, shares and filters stay attached. Rolling back to an older image
  needs that backup.
- Every user, node and hub must sign in again. For the user rows to line up
  with the new tokens, a user's asterism `sub` must equal their existing
  `users.id`.

## Log rotation

The relay logs structured JSON to stdout (Pino) — there's no log file on
disk for the relay itself to rotate. For Docker deployments, configure
rotation at the container runtime level instead: Docker's `json-file`
logging driver supports `max-size`/`max-file` options, set via
`docker compose`'s `logging:` key. If you're deploying on a platform that
collects container stdout for you (Railway, Fly, etc.), check that
platform's own log-retention settings — there's nothing Constellation-side
to configure either way, since the relay never writes its own log file.

This is different from the hub's audit log, which *is* a real file on the
hub's own disk and does need `logrotate` or similar — see
[hub.md's Audit log section](hub.md#audit-log) for that.

Audit writes fail open on a full or unwritable disk — a tool call still
succeeds even if its audit entry couldn't be written — so a filling disk
won't surface as an error anywhere on its own. `constellation hub status
--json` reports free/total bytes for the filesystem holding the audit log
(`audit_log.disk`); poll that from whatever you use for host-level alerting
if you want one before the disk actually fills.
