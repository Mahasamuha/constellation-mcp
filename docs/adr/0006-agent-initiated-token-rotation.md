# ADR 0006: Node-Initiated Token Rotation; Tokens Stored as Hashes

**Status:** Accepted  
**Date:** 2026-06-06

## Context

Agent tokens are long-lived credentials stored in the node's local config file.
Two questions arose during design: (1) how should token rotation work, and (2) how
should tokens be stored in the database.

## Decision

**Token rotation is node-initiated.** The relay cannot push a new token to the node
unsolicited. The flow:

1. Node sends `{ type: "rotate_token" }` over the existing WebSocket.
2. Relay generates a new token, stores it, returns `{ type: "token_rotated", token: "<new>" }`.
3. Node writes the new token to `node.yaml` and reconnects.
4. Relay revokes the old token atomically on successful reconnect with the new token.

The node has a 5-minute window to reconnect. If it fails to reconnect, the new token
is revoked and the old token continues to work — no lockout. If both tokens are
independently revoked during the window, the node must re-run `constellation node init`.

**Tokens are stored as SHA-256 hashes.** Agent tokens and OAuth tokens are 32-byte
cryptographically random values (`crypto.randomBytes(32).toString('hex')`). Only the
hash is stored in Postgres. Tokens are never logged in plaintext.

## Rationale

Node-initiated rotation matches the threat model: the relay is less trusted than the
node's local machine. A relay that can push new tokens can effectively revoke access
and replace credentials at will. Keeping rotation node-initiated ensures the user's
machine remains in control of its own credentials.

The 5-minute no-lockout window prevents a crash between receiving `token_rotated` and
writing to disk from permanently locking out the node. The tradeoff is a brief window
where both old and new tokens are valid.

Storing tokens as hashes means a database read (e.g., via a SQL injection or backup
exposure) does not yield usable credentials. The hash is sufficient for the lookup and
constant-time comparison needed at authentication time.

## Alternatives Considered

**Relay-initiated rotation (push model):** the relay can revoke a token and
issue a new one without the node requesting it. Rejected because it gives the relay
unilateral credential control — a compromised relay can lock out all nodes.

**Revocation-only (no rotation):** tokens can be revoked but not rotated in-place.
The node must re-run `node init` to get a new token. Operationally acceptable but
higher friction for routine credential hygiene. Rotation-in-place was preferred.

**Storing plaintext tokens:** faster lookup (no hash comparison), but a DB read
exposes usable credentials. Rejected.

## Consequences

- `node.yaml` and `relay-session.yaml` should be `chmod 600`, owned by the node's
  user. The node refuses to transmit its token over an unencrypted connection to any
  non-localhost host.
- The `revoked_at` column on `agent_tokens` is nullable. `IS NOT NULL` is the
  revocation check — no separate boolean field required.
- `last_used_at` on `agent_tokens` is updated on each WebSocket connection using
  that token. Useful for auditing stale tokens.
- Rotation is exposed via `constellation node rotate` (CLI) and the Danger Zone in
  the node GUI. The relay management API exposes only revocation, not rotation.
- `constellation hub rotate-token` follows this same protocol (see
  [ADR 0019](0019-hub-live-token-rotation.md) for hub-specific details: it persists
  to `env_file` instead of `node.yaml`, and a daemon-reachability check via a
  loopback control channel comes first, since a second hub connection authenticated
  with the same token would evict the running daemon's live connection).
