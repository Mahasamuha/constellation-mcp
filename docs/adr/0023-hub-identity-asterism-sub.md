# ADR 0023: Hub Identity Keys on the asterism Sub; `constellation_username` Is Untrusted Input

**Status:** Accepted — supersedes [ADR 0010](0010-hub-three-tier-identity.md); amends [ADR 0001](0001-rpc-envelope-not-shared.md) and [ADR 0018](0018-share-rpcenvelope-via-inheritance.md)
**Date:** 2026-10-27

## Context

[ADR 0022](0022-asterism-authorization-server.md) moves authorization to asterism.
Constellation now knows a user only by the asterism access token: `sub` (asterism's user
id, which equals `users.id`) and the claims asterism releases to it (`groups`, `email`,
`constellation_username`). The upstream identity provider's subject (`oidc_sub`) is no
longer visible, so everything the hub keyed on it has to move: the RPC envelope field
`user_oidc_sub`, per-share permission overrides, `identity.user_map`, and the audit log.

Moving the keys is also the moment to fix how the hub treats the claim that picks the OS
account. `constellation_username` decides which OS user the hub drops privileges to, so a
wrong resolution is a privilege-escalation bug, and the old code treated the claim
generously:

- `getent passwd <arg>` resolves a **UID** as well as a name, so a claim of `1000`,
  `+1000` or `01000` mapped to whichever account has that UID.
- A claim that was present but did not resolve silently fell through to `user_map` (and
  to the opt-in `preferred_username` tier), so a bad value changed which rule applied
  rather than failing.
- The name used afterwards (ACLs, audit, group lookup, subnode key) was the claim
  string, not what the passwd database returned.

## Decision

**Envelope.** The relay's envelope replaces `user_oidc_sub: string | null` with
`user_sub: string` (the token's `sub`) and `user_groups: string[]`. `user_groups` is
always sent in full and is not subject to `forwarded_claims`, because a group override
can restrict access as well as grant it; a hub missing a group would over-grant against
the default. `user_claims` is still filtered by `forwarded_claims` when that is set. The
hub refuses an RPC whose `user_sub` is missing or not a non-empty string, and one whose
`user_groups` is not an array. There is no fallback. There is also no protocol version
negotiation between relay and hub; they upgrade together, and the hub's refusal makes a
mixed deployment fail loudly.

**Permissions.** A share's overrides are `{ sub, access }` or `{ group, access }` (exactly
one of `sub` or `group`). Evaluation lives in `@constellation/shared`
(`evaluatePermissionBlob`) and is used by both the relay (optimistic) and the hub
(authoritative): a `sub` override wins outright; otherwise the most permissive matching
`group` override applies; otherwise the default. A legacy `oidc_sub` is a hub config
error naming the share and index, and the relay rejects it in `hub_share_sync` with a
message telling the operator to re-key it.

**Identity chain: two tiers.**

1. `identity.claims` (normally `constellation_username`).
2. `identity.user_map`, now `{ sub, local_username }`. A legacy `oidc_sub` key is a config
   error.

Tier 3 (`preferred_username`) is removed, and `identity.allow_preferred_username` is a
config error if present.

**Claim values are untrusted input.**

- A cheap pre-filter: `^[A-Za-z_][A-Za-z0-9._@-]{0,255}$`. The first character is a
  letter or `_`, so a value is never numeric and never starts with `-`. Mixed case, `.`
  and SSSD names (`user@domain.example`) pass; whitespace, `+`, `:`, `/`, `\`, unicode
  and control characters do not.
- The real guard is an exact-name check: the passwd entry's name (`parts[0]` of the
  getent line) must equal the claim, case-sensitively, and that name is used from then on.
- A claim that is **present but invalid, unresolved or mismatched** is a hard refusal. A
  present claim that is not a string (array, object, number, null) is too. Only an
  **absent** claim moves on to tier 2.
- `user_map[].local_username` gets the same pattern and exact-name check (the config
  validator also checks the pattern).
- If no tier resolves, the RPC is refused with the generic identity error. There is no
  fallback to the hub's own identity.

**Audit.** The audit record's `user_oidc_sub` becomes `user_sub`. Groups are not logged:
they can run to 256 entries per record, and the sub plus the share's config at the time
reconstructs the decision.

`subnode.ts`'s checks (refusing uid 0, the hub's own uid, and out-of-range uids) are
unchanged; they are the second line of defence behind this one.

## Rationale

The sub is the only stable identifier Constellation still has, and it is the one asterism
vouches for. Groups come from the same token, so one source decides both who the user is
and what they belong to.

Treating the claim as hostile closes the UID-as-name aliasing without relying on getent's
behaviour: the pattern makes numeric values impossible, and the exact-name comparison
catches anything else NSS might answer for (aliases, case folding by a directory, or a
different entry than was asked for). Making a bad present claim fatal removes a class of
bug where a malformed attribute silently changed which identity rule applied. Removing
tier 3 drops a tier that was already disabled by default and documented as risky.

## Alternatives Considered

**Keep `oidc_sub` fields alongside `sub`.** The upstream subject is not available, so the
fields could never match. Accepting them silently would leave overrides that look active
and do nothing; a loud config error is better.

**Treat a missing `user_groups` as an empty list.** Rejected: a group override can deny,
so dropping the list can grant default access the operator meant to restrict.

**Only the pattern, or only the exact-name check.** The pattern alone trusts getent to
return the entry that was asked for; the exact-name check alone would still send odd
strings (leading `-`, whitespace, control characters) to `getent` and `id`. Both are
cheap, so both stay.

**Version the relay/hub protocol.** None exists today. Adding one for a single breaking
change is more machinery than the hub's refusal of a malformed envelope, given that relay
and hubs are deployed by the same operator.

## Consequences

- Operators must re-key `oidc_sub` entries in hub configs (share overrides and
  `user_map`) to `sub` or `group` before upgrading, and remove
  `allow_preferred_username`. A hub with an old config will not start.
- Relay and hubs must be upgraded together. An old hub sees no `user_oidc_sub` it
  recognises; a new hub refuses an old relay's envelope (no `user_sub`).
- A user whose `constellation_username` is wrong (typo, wrong case, nonexistent account)
  is now refused instead of silently using their `user_map` entry. That is intended;
  fix the attribute in the directory or remove it so the map applies.
- Hub shares sync with `access` of `none`, `read-only` or `read-write`. (The relay
  previously validated `read` instead of `read-only`, which the hub never sends.)
- `docs/hub.md` and `HUB_QUICKSTART.md` describe the new config.
