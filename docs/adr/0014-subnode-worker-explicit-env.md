# ADR 0014: Subnode Workers Get an Explicit, Minimal Environment (Never `process.env`)

**Status:** Accepted
**Date:** 2026-06-06

## Context

The hub forks one subnode worker per resolved OS user
(`SubnodePool.spawn` in `packages/hub/src/subnode.ts`). Each worker
immediately drops privileges — `initgroups` → `setgid` → `setuid` — to the
requesting user's OS identity (`subnode-worker.ts`), which may be an arbitrary,
low-trust local account.

The original implementation forked the worker with `env: { ...process.env, ... }`,
spreading the parent's entire environment into the child before the privilege
drop. The hub's parent process holds `CONSTELLATION_HUB_TOKEN` (the
relay bearer token, read at startup and left in `process.env`) and potentially
other secrets sourced from `env_file`. Once the worker setuid()s to the target
user, that user can read their own process's environment via
`/proc/<pid>/environ` — recovering the hub's relay token and anything else
that was inherited. This would let a malicious local user impersonate the
hub to the relay (re-sync labels with forged permission blobs, etc.).

## Decision

The forked worker receives an explicitly constructed environment
(`buildWorkerEnv` in `subnode.ts`), never a spread of `process.env`. It
contains only:

- `CONSTELLATION_TARGET_USER` / `_UID` / `_GID` — required by the worker to
  identify who to drop privileges to.
- `HOME`, `USER`, `LOGNAME` — set to the *target* user's values (home directory
  resolved via `getpwnam`/`getent passwd`, field 6), not the hub service
  account's. Running with the hub's `HOME` after dropping to another user's
  uid would point any home-relative behavior at a directory the worker can no
  longer write to (and would leak the hub's home path to the target user).
- `PATH` — passed through from the parent, needed for normal Node module/
  binary resolution.
- `LOG_LEVEL` — passed through so worker logging respects the configured level
  (read by `createLogger` in `@constellation/shared`).

`CONSTELLATION_HUB_TOKEN` and everything else in the parent's environment —
including any other secrets sourced via `env_file` — are never passed to the
worker.

**If the worker ever needs a new environment variable, it must be added
explicitly to `buildWorkerEnv`.** Do not widen this back to `...process.env`;
that silently reintroduces the leak. This is also called out in a comment
directly above `buildWorkerEnv` and in `docs/hub.md` under "Token
security", since a missing variable here will look like an unrelated bug
("why isn't FOO propagating to the subnode?") rather than a deliberate
security boundary.

## Rationale

The executor tools the worker runs (`fs-read`, `fs-write`, `fs-edit`,
`fs-search`) are pure filesystem operations — they don't shell out, and don't
read `process.env` beyond what Node/the logger need (`PATH`, `LOG_LEVEL`).
There is no functional reason for the worker to see the parent's full
environment, and every variable it doesn't need is a variable that can leak a
secret to a privilege-dropped, potentially adversarial local user.

## Alternatives Considered

**Spread `process.env` but delete `CONSTELLATION_HUB_TOKEN` first:** narrower
fix, but fragile — it requires remembering to strip every secret (including
ones added later via `env_file`, which are sourced directly into `process.env`
by `sourceEnvFile`). An allowlist is the only approach that fails safe when a
new secret is introduced upstream.

**Don't set `HOME`/`USER`/`LOGNAME` at all (let them leak from the hub):**
rejected — besides leaking the hub service account's home path to the
subnode's user, it's also simply wrong: the worker is running as a different
uid and should present that user's identity to any library that inspects it.

## Consequences

- `ResolvedIdentity` (`packages/hub/src/identity.ts`) now carries `home`, sourced from
  the sixth field of the `getent passwd` record alongside `uid`/`gid`.
- Any future addition to the worker's runtime needs (e.g. a new env-driven
  feature flag) must be threaded through `buildWorkerEnv` explicitly.
