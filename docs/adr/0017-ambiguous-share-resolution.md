# ADR 0017: Ambiguous Share Resolution Returns an Error Instead of Requiring `host`

**Status:** Accepted  
**Date:** 2026-06-19

## Context

`HubShare` is unique per-executor (`@@unique([executorId, share])`), not per-user
— see ADR 0009 and ADR 0011. Two independently-administered hubs can therefore
register a share with the same name, and a single user could have access to
both. `resolveShare`/`resolveHubShare` in `packages/relay/src/router.ts`
previously resolved a `share` name (with an optional `host` filter) by querying
`HubShare` and returning the first row for which the user's evaluated
permission was not `"none"` — silently arbitrary whenever more than one match
existed.

Separately, `routeToolCall`'s `copy`/`move` handling resolves a `dst_share`
parameter to find the destination's absolute root, but called `resolveShare`
with `host: undefined`, ignoring that the source share's host was already
known — opening the same ambiguity gap on the destination side, with
cross-host mismatches only caught after the fact via the existing `cross_host`
rejection.

Shares were originally called "labels": the intent was for a model to address
a location by name and per-share `instructions` alone, without needing to
reason about which physical host backs it. Making `host` a required parameter
on every share-resolution and copy/move tool call (the originally proposed
fix for the collision above) would have formalized away that property, and
would have broken `packages/telescope/src/FileBrowserApp.tsx` (the MCP Apps
file browser), which calls `read_file`/`write_file`/`list_directory` without
`host` — despite already having it available per-share from `list_shares`.

## Decision

`host` remains optional on every MCP tool that resolves a share
(`list_directory`, `file_info`, `find_files`, `read_file`, `grep_files`,
`write_file`, `edit_file`, `copy`, `move`, `create_directory`, `delete`). No
tool schema was changed.

Instead, `resolveHubShare` evaluates permissions for all matching `HubShare`
rows first, then:

- 0 accessible matches → `null` (falls through to `share_not_found` /
  `host_not_found` as before).
- Exactly 1 accessible match → resolves normally.
- More than 1 accessible match → returns a new `RouterError` code,
  `"ambiguous"`, with a message listing the candidate hosts, instead of
  picking one arbitrarily.

The ambiguity check only ever considers shares the requesting user can already
see: hub-share candidates are filtered by `evaluatePermissionBlob` (excluding
`"none"`) before being counted, and personal `PathShare` lookups are
`userId`-scoped and inherently unique (`@@unique([userId, share])`, left
unchanged — see Alternatives Considered). A user is never told about, or asked
to disambiguate against, a share outside their own access.

`routeToolCall`'s `dst_share` resolution for `copy`/`move` now passes the
source share's already-resolved host explicitly, instead of `undefined`.
Cross-host copy/move remains rejected outright (existing `cross_host` error)
and is not planned to be supported.

`packages/telescope/src/FileBrowserApp.tsx` was updated to track each share's
`host` (already returned by `list_shares` and shown in the UI) and pass it on
every `read_file`/`write_file`/`list_directory` call, since it has no UI
mechanism to act on an `"ambiguous"` error if one occurred.

## Rationale

`host` is overwhelmingly irrelevant in practice: a given user's shares
essentially never collide by name, since collisions can only happen via
independently-administered hub shares. Forcing every caller — model and UI
alike — to supply `host` on every call would optimize for a rare case at the
cost of the common one, and would have broken telescope's existing host-less
calls. Detecting genuine ambiguity and returning a descriptive error keeps
`host` load-bearing only on the rare retry, preserving the original "label"
ergonomics (name + `instructions` as the primary handle) while remaining
fully correct and access-safe.

## Alternatives Considered

**Require `host` on all share-resolution/copy-move tool calls** (the original
proposal): rejected — breaks telescope's existing calls, and formalizes away
the semantic, host-agnostic addressing "labels" were designed to provide, for
a collision that is rare in practice.

**Relax `PathShare`'s `@@unique([userId, share])`** to allow duplicate
personal share names disambiguated by host: rejected — a single user fully
controls their own share names and has no structural reason to want
duplicates, unlike hub shares where naming collisions across
independently-administered operators are unavoidable. Keeping personal shares
uniquely named avoids introducing this same ambiguity where it brings no
benefit.

**Enforce global uniqueness on hub share names across all hubs:** would fully
restore "no host ever needed" addressing, but requires rejecting or renaming a
hub's share registration whenever it collides with a name used by some other
hub the operator has no visibility into. Rejected as brittle for hub
operators.

## Consequences

- A model or UI that omits `host` and hits a genuine collision gets a clear
  `"ambiguous"` error listing the candidate hosts, rather than a silently
  wrong (or merely lucky) resolution. The caller is expected to retry with
  `host` set, or to ask the user up front if it doesn't already know which is
  intended.
- `copy`/`move` destination resolution is always scoped to the source share's
  resolved host; cross-host copy/move continues to be rejected.
- `packages/telescope/src/FileBrowserApp.tsx` now always supplies `host` for
  every file-access call, since it has no way to handle an `"ambiguous"`
  error in its current UI.
- `PathShare`'s `@@unique([userId, share])` is unchanged — personal shares
  remain uniquely named per user.
