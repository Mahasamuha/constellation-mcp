# ADR 0006: Agent-Initiated Token Rotation; Tokens Stored as Hashes

**Status:** Accepted  
**Date:** 2026-06-06

## Context

Agent tokens are long-lived credentials stored in the agent's local config file.
Two questions arose during design: (1) how should token rotation work, and (2) how
should tokens be stored in the database.

## Decision

**Token rotation is agent-initiated.** The broker cannot push a new token to the agent
unsolicited. The flow:

1. Agent sends `{ type: "rotate_token" }` over the existing WebSocket.
2. Broker generates a new token, stores it, returns `{ type: "token_rotated", token: "<new>" }`.
3. Agent writes the new token to `agent.yaml` and reconnects.
4. Broker revokes the old token atomically on successful reconnect with the new token.

The agent has a 5-minute window to reconnect. If it fails to reconnect, the new token
is revoked and the old token continues to work — no lockout. If both tokens are
independently revoked during the window, the agent must re-run `constellation agent init`.

**Tokens are stored as SHA-256 hashes.** Agent tokens and OAuth tokens are 32-byte
cryptographically random values (`crypto.randomBytes(32).toString('hex')`). Only the
hash is stored in Postgres. Tokens are never logged in plaintext.

## Rationale

Agent-initiated rotation matches the threat model: the broker is less trusted than the
agent's local machine. A broker that can push new tokens can effectively revoke access
and replace credentials at will. Keeping rotation agent-initiated ensures the user's
machine remains in control of its own credentials.

The 5-minute no-lockout window prevents a crash between receiving `token_rotated` and
writing to disk from permanently locking out the agent. The tradeoff is a brief window
where both old and new tokens are valid.

Storing tokens as hashes means a database read (e.g., via a SQL injection or backup
exposure) does not yield usable credentials. The hash is sufficient for the lookup and
constant-time comparison needed at authentication time.

## Alternatives Considered

**Broker-initiated rotation (push model):** the broker can revoke a token and
issue a new one without the agent requesting it. Rejected because it gives the broker
unilateral credential control — a compromised broker can lock out all agents.

**Revocation-only (no rotation):** tokens can be revoked but not rotated in-place.
The agent must re-run `agent init` to get a new token. Operationally acceptable but
higher friction for routine credential hygiene. Rotation-in-place was preferred.

**Storing plaintext tokens:** faster lookup (no hash comparison), but a DB read
exposes usable credentials. Rejected.

## Consequences

- `agent.yaml` and `broker-session.yaml` should be `chmod 600`, owned by the agent's
  user. The agent refuses to transmit its token over an unencrypted connection to any
  non-localhost host.
- The `revoked_at` column on `agent_tokens` is nullable. `IS NOT NULL` is the
  revocation check — no separate boolean field required.
- `last_used_at` on `agent_tokens` is updated on each WebSocket connection using
  that token. Useful for auditing stale tokens.
- Rotation is exposed via `constellation agent rotate` (CLI) and the Danger Zone in
  the agent GUI. The broker management API exposes only revocation, not rotation.
