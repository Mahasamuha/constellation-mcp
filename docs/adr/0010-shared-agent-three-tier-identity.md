# ADR 0010: Three-Tier OS Identity Resolution for Shared Agent

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The shared agent receives an RPC containing `user_oidc_sub` and OIDC claims from the
broker. Before spawning a subagent under the requesting user's OS identity, the shared
agent must resolve that OIDC identity to a local OS username. The resolution strategy
must handle LDAP/AD environments, direct mappings, and common OIDC claim patterns while
defaulting to a secure posture when resolution fails.

## Decision

Identity resolution uses a three-tier priority chain. The first successful resolution
wins. If no tier resolves, the RPC is rejected with a typed `IdentityResolutionError` —
there is no fallback to the agent's own OS identity.

**Tier 1 — Custom OIDC claims (recommended)**

Iterate `identity.claims` from config in order. For each claim, read the value from
the RPC envelope; if non-empty, attempt OS lookup (`getpwnam` on Linux). First
successful OS lookup wins. This tier is LDAP-friendly: configure a property mapping in
Authentik (or equivalent) to forward a directory attribute (`uid`, `sAMAccountName`)
as a custom claim. The agent trusts the OIDC provider as authoritative for the claim
value.

**Tier 2 — Explicit `user_map` config**

Look up `user_oidc_sub` in the `identity.user_map` config list. If found, verify
the mapped `local_username` exists via OS lookup before accepting. Used when custom
claims are unavailable or a per-user override is needed.

**Tier 3 — `preferred_username` (opt-in, disabled by default)**

Only attempted if `allow_preferred_username: true` is set in config. Attempts OS lookup
of the `preferred_username` claim directly. Disabled by default because
`preferred_username` is editable by users on many OIDC providers (including Authentik
with default settings) and can be used for lateral movement — a user who controls their
`preferred_username` claim can resolve to any local account.

Config validator emits a security warning when Tier 3 is enabled.

## Rationale

The three-tier model matches the diversity of real deployment environments:

- LDAP/AD shops use directory-authoritative claims (Tier 1) — zero config per user.
- Small deployments or migrations use explicit maps (Tier 2) — deterministic, auditable.
- Simple single-provider setups may use `preferred_username` if the provider locks it
  (Tier 3, opt-in).

No fallback to the agent's own identity. Silent fallback would mean a misconfigured
identity tier silently runs all RPCs as the service user — a security hole. Hard
rejection on failure is the only safe default.

`user_oidc_sub` is always forwarded in the RPC envelope (controlled by `forwarded_claims`
broker config, which defaults to forwarding all claims). It is the stable identity anchor
for Tier 2 and audit logging regardless of which tier resolves.

## Alternatives Considered

**Single-tier explicit map only:** simple and auditable but requires per-user
configuration on the agent host. Unusable at scale in LDAP environments. Rejected as
the default.

**`preferred_username` as Tier 1:** rejected because many providers allow users to
modify this claim. Using it as the primary resolution path would allow lateral movement
in misconfigured environments.

**No identity resolution (single shared OS user):** all RPCs run under the service
user. Eliminates the complexity but eliminates OS-level per-user isolation. Rejected —
OS identity separation is the primary security guarantee of the shared modality.

## Consequences

- The three-tier config is defined in the shared agent YAML (see `shared-modality.md §3.1`).
- The agent resolves identity but does not provision local accounts. Resolved usernames
  must already exist on the host. In LDAP/AD environments, provisioning is out-of-band
  (SSSD, SCIM, Ansible, GPO, etc.).
- Sub-path access control within a label is enforced entirely by the OS filesystem
  permissions of the subagent's OS identity — the agent does not implement
  fine-grained path-level ACLs.
- Windows support (S4U2Self impersonation) is out of scope for the initial shared
  agent implementation. The three-tier resolution model applies unchanged; only the OS
  lookup and impersonation mechanism differ.
- All RPC outcomes (including identity resolution failures) are written to the audit
  log with `local_username: null` on failure.
