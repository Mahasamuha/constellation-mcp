# ADR 0020: RFC 9728 Discovery; Dynamic Client Registration Is Public-Only

**Status:** Accepted
**Date:** 2026-10-19

## Context

ADR 0004 made `/.well-known/oauth-authorization-server` (RFC 8414) the discovery entry
point and Dynamic Client Registration (RFC 7591) the primary onboarding path. Since
then, the MCP auth specification has made OAuth 2.0 Protected Resource Metadata
(RFC 9728) mandatory: clients start discovery from the `WWW-Authenticate` header on a
`401` from `/mcp`, follow its `resource_metadata` pointer to
`/.well-known/oauth-protected-resource`, and only then find the authorization server.

A review against RFC 9728 and RFC 8414 found:

- Only the "no token" `401` carried `resource_metadata`; the `invalid_token` `401` did not.
- CORS did not expose `WWW-Authenticate`, so browser-based clients could not read it.
- Both well-known documents are built as `${RELAY_URL}/.well-known/...`. RFC 9728 §3.1
  and RFC 8414 §3.1 insert the well-known segment between host and path, so this is
  only correct when `RELAY_URL` is a bare origin. A trailing slash also breaks exact
  `issuer` matching.
- `/oauth/register` defaulted `token_endpoint_auth_method` to `client_secret_basic`
  (the RFC 7591 default) and issued a secret, but the token endpoint only accepts
  `client_secret_post` and the metadata did not advertise Basic. A confidential client
  that omitted the field was told to use Basic and then failed with `invalid_client`.
  RFC 6749 §2.3.1 requires an authorization server to support Basic for any client it
  issues a secret to.

## Decision

- **Protected Resource Metadata is the discovery entry point.** Every `401` from `/mcp`
  carries `resource_metadata="${RELAY_URL}/.well-known/oauth-protected-resource/mcp"`, and
  `WWW-Authenticate` is a CORS-exposed header.
- **The `resource` identifier is `${RELAY_URL}/mcp`.** RFC 9728 §3.3 requires the
  `resource` in the metadata to equal the URL the client used to reach the resource, so
  a client that discovers metadata via `WWW-Authenticate` rejects an origin-only
  `resource`. The path-inserted `/.well-known/oauth-protected-resource/mcp` serves this
  document. The root `/.well-known/oauth-protected-resource` is kept, unchanged
  (`resource` is the relay origin), for older clients that probe it directly; an
  origin-only `resource` is only valid there, where the client is probing the origin.
- **`RELAY_URL` must be a bare origin.** The relay refuses to start if it has a path,
  query, fragment, or trailing slash. Sub-path deployments are not supported.
- **DCR registers public clients only.** An omitted `token_endpoint_auth_method` is
  replaced with `"none"` (RFC 7591 §3.2.1 lets the server replace requested values; the
  response states the value in effect). Any other requested value is rejected with
  `invalid_client_metadata`. No client secrets are issued, and the authorization server
  metadata advertises `token_endpoint_auth_methods_supported: ["none"]`.

## Rationale

Not issuing secrets removes the RFC 6749 obligation to support Basic, rather than
adding a second credential-parsing path to the token endpoint. Mainstream MCP clients
already register as public clients and rely on PKCE, which ADR 0004 made mandatory, so
a client secret adds no protection for them.

Validating `RELAY_URL` at startup turns a misconfiguration that would silently break
discovery for some clients into a boot failure.

## Alternatives Considered

**Support `client_secret_basic` at the token endpoint:** the spec-complete fix for
confidential DCR clients. It would require a stored per-client auth method (migration),
correct Basic decoding (base64, then form-urldecoding per RFC 6749 §2.3.1), rejection of
mixed header/body credentials, and a `401` with `WWW-Authenticate: Basic`. Rejected
because no known MCP client needs a confidential DCR registration.

**Default omitted methods to `client_secret_post`:** permitted by RFC 7591 §3.2.1 and
the smallest change, but still issues secrets without supporting Basic, which leaves the
relay out of compliance with RFC 6749.

**Keep `resource` as the relay origin and defer the path change:** this was the original
decision, on the belief that RFC 9728 permits an origin-only `resource` for the `/mcp`
endpoint. It does not (§3.3, above), so the path-specific document was added instead.

## Consequences

- A client that explicitly requests `client_secret_basic`, `client_secret_post`, or any
  other non-`"none"` method at `/oauth/register` now receives `400`.
- Clients registered before this change with a secret still authenticate. The token
  endpoint keeps checking `client_secret` in the request body for clients that have a
  stored secret hash. That check can be removed once no such rows remain.
- Deployments with a trailing slash or path in `RELAY_URL` fail at startup until it is
  corrected.
- Clients that probe only the root well-known document still get the origin-only
  `resource`. That document can be removed once no such clients remain.
- Remaining work: RFC 8707 audience binding is not yet implemented. Client ID Metadata
  Documents (the registration method the MCP spec now prefers) are covered by
  [ADR 0021](0021-client-id-metadata-documents.md).
