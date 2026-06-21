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
shares, deny filters, OAuth clients/sessions, and the activity log all live
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
- **Local user accounts** (`AUTH_MODE=local`) and **admin role
  assignments** — without a backup, local accounts need to be recreated
  (`constellation relay users add`) and admins re-promoted
  (`constellation relay user promote`).
- **Activity log** — historical audit data only; losing it has no functional
  effect on the running system, but it does mean losing whatever audit trail
  you had before the backup.
- **OAuth sessions and dynamically-registered MCP clients** — lost, but this
  self-heals automatically: clients re-discover and re-register
  (`POST /oauth/register`) and users re-authenticate on their next request.
  No manual recovery step.

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
docker compose pull
docker compose up -d
```

Migrations apply automatically on every start, so this is the entire
procedure for routine updates — no manual migration step. As with any
schema change, taking a fresh backup immediately before pulling a new image
is cheap insurance, particularly across a large version jump; check the
relay's changelog/migration history for that range if you're skipping
several releases at once.

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
