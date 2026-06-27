# ADR 0019: Hub Token Rotation Is Live, Not Restart-Bound

**Status:** Accepted
**Date:** 2026-06-22

## Context

`hub rotate-token` originally opened a second WebSocket connection — authenticated
with the same, still-active token the running daemon was already using — to request
a new token from the relay, wrote the result to `env_file`, and told the operator to
restart the hub. This had two problems:

1. A second connection authenticating with the same token causes the relay to treat
   the daemon's existing connection as stale and evict it (the relay allows only one
   live connection per executor) — so simply *requesting* a rotation disrupted every
   in-flight RPC on a production hub, even before the rotation itself completed.
2. Picking up the new token required a manual restart, unlike `node rotate`
   (ADR 0006), which asks the running daemon to rotate on its own connection and
   reconnect immediately, no restart needed.

This looked, at first, like it might be required by [ADR 0013](0013-hub-restart-only-config.md)
("Hub Config Changes Require Process Restart") — but tracing it down, it wasn't.

## Decision

**Hub now rotates its token the same way node does:** the daemon (`HubSocket`)
sends `{ type: "rotate_token" }` on its own live connection (the relay-side handler,
`handleRotateToken`, was already generic over node/hub), persists the result to
`env_file`, updates its own in-memory token, and reconnects immediately — all without
restarting. `hub rotate-token` now asks the running daemon to do this over a loopback
control channel (mirroring node's `control.ts`, now extracted to
`@constellation/shared/control-channel`) instead of opening a second connection. If no
daemon is reachable, it falls back to the original direct-connection-and-restart path,
which is safe in that case since there's no live connection to evict.

## Rationale

ADR 0013's restart requirement is scoped to config that affects *which security
decision applies to an in-flight request* — identity resolution, share permissions,
UID ranges. Its rationale is specifically about avoiding a window where one request's
permission check ran under old rules and another's runs under new ones. The relay
auth token has no such property: it's checked once, at connection handshake, never
per-RPC. Rotating it in place doesn't reopen any of the windows ADR 0013 exists to
close.

Separately, [ADR 0014](0014-subnode-worker-explicit-env.md) is why the token is kept
out of `HubConfig` and sourced from `env`/`env_file` instead: spreading it into a
forked, setuid'd subnode worker would hand the hub's own credential to whatever local
user that worker just became. That property only forbids "the token lives in the
shared config object" — it says nothing about the daemon's own connection holding a
private, mutable copy of its current token in memory. `buildWorkerEnv()` constructs
each worker's environment from scratch regardless of how many times the daemon's
token has changed since boot, so live rotation doesn't weaken that isolation at all.

Once both of those were separated out, there was no actual constraint left requiring
a restart — only a soft, auditability-flavored preference (tying every credential
change to a logged process restart). Weighed against hub being the multi-tenant,
higher-traffic component — the one that most needs to avoid an interruption, not
least — continuous availability won.

## Consequences

- `HubSocket.hubToken` is mutable, not `readonly`. It starts from `env`/`env_file` at
  boot, same as before, but the daemon can update it in place for the rest of its
  lifetime once a rotation completes.
- The control-channel mechanism (`startControlServer`/`requestRotateViaControlChannel`)
  moved from `packages/node/src/control.ts` to `packages/shared/src/control-channel.ts`
  — it was already fully generic, and hub needed the exact same thing rather than a
  second, parallel copy.
- `hub install`'s generated systemd unit now grants `ReadWritePaths` to `env_file`'s
  directory when one is configured (previously only `/var/log/constellation`), since
  the daemon itself — not just the CLI invocation — now writes there at runtime.
- The hub's control-channel socket file lives next to the audit log (always present,
  already granted) rather than `env_file`'s directory, so the control channel itself
  needs no new systemd grant — only persisting an actual rotated token does.
- ADR 0006's "node-initiated" framing and protocol mechanics are unchanged and now
  shared by hub verbatim; this ADR doesn't supersede it, it completes hub's side of
  the same already-decided design.
