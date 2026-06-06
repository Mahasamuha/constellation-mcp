# ADR 0008: Admin Elevation via adminUntil on OauthSession (Not a Separate Token)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

Some broker management operations — user management, shared agent registration approval
— should be restricted to designated admins. The question was how to model admin
capability: a separate admin token, a persistent role on the session, or a time-bounded
elevation flag.

## Decision

Admin capability is a time-bounded flag on the existing `OauthSession` row, not a
separate token.

Schema addition:
```prisma
model OauthSession {
  // ... existing fields ...
  adminUntil DateTime? @map("admin_until") // null = not elevated
}
```

The `requireAdmin` middleware checks `adminUntil > now` on the session. A `null` or
expired `adminUntil` returns `403 { "error": "ESCALATION_REQUIRED" }`.

**Escalation flow:**
1. Client requests an admin-gated endpoint with a regular session token.
2. Broker returns `403 ESCALATION_REQUIRED` (always, regardless of the user's role —
   never leak privilege status in the error).
3. CLI initiates a device code flow, passing `elevate_session_id` in the request body.
   The broker stores this on the `DeviceCode` row.
4. On browser approval, the broker checks `BrokerRole.ADMIN` on the `User` row:
   - `ADMIN`: sets `adminUntil = now + admin_session_duration` on the target session.
   - `USER`: returns `403 ESCALATION_REQUIRED`. No oracle.
5. CLI retries the original operation with the same access token.
6. When `adminUntil` lapses, the next admin-gated request returns
   `403 ESCALATION_REQUIRED` again.

**Role assignment (OIDC mode):** on every login, the broker evaluates the user's OIDC
group claims against `admin_groups` in broker config. If the user belongs to any listed
group, `role: ADMIN` is set on the `User` row. Re-evaluated on every login — revoking
a group in Authentik takes effect on next session.

**Bootstrap CLI (local mode or pre-OIDC-group configuration):**
- `constellation broker user promote <sub-or-username>`
- `constellation broker user demote <sub-or-username>`

These are the only direct role mutations. There is no API endpoint for role management.

**Important distinction:** the `requireAdmin` middleware (checks `adminUntil` on an
existing session) is separate from the admin check at shared agent registration approval
(checks `BrokerRole.ADMIN` on the `User` row at device code approval time, with no
`adminUntil` involved). These are complementary enforcement points, not redundant ones.

## Rationale

One token always. Step-up reauth mutates the session server-side; the client retries
with the same token it already has. This avoids token exchange and keeps the client
implementation simple. Elevation is session-scoped — stepping up in one CLI session
does not affect other active sessions for the same user.

A separate admin token would require the client to manage two tokens and decide which
to use per request. A persistent role on the session (no expiry) would mean a stolen
session token grants permanent admin access with no time bound.

The `403 ESCALATION_REQUIRED` response is always returned for admin-gated endpoints
regardless of the user's role. This prevents an attacker from probing which users are
admins by observing different error responses.

## Alternatives Considered

**Separate admin token:** client manages two tokens; deciding which to use per request
adds complexity. A stolen admin token grants full admin access with no expiry.

**Persistent admin flag on session:** no time bound means stolen tokens are
permanently elevated. Rejected.

**Admin-only sessions (separate login flow):** users log in twice — once for normal
access, once for admin. Friction not warranted for the expected admin frequency.

## Consequences

- `admin_session_duration` broker config field (default: 3600 seconds). Configurable.
- `admin_groups` broker config field — list of OIDC group claim values that map to
  `BrokerRole.ADMIN`. Empty list means no users are admins via OIDC groups.
- `DeviceCode` schema gets an `elevateSessionId` field to carry the target session
  through the approval flow.
- For v1, the 1-hour default and the full reauth requirement (not just a token refresh)
  are the primary mitigations against elevated session token theft. Hardening options
  (origin binding, non-extractable DPoP-style binding) are documented in
  `plans/future-deferred.md` as post-v1 work.
