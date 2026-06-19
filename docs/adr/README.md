# Architecture Decision Records

| # | Title | Status |
|---|---|---|
| [0001](0001-rpc-envelope-not-shared.md) | Do Not Share RpcEnvelope Across Node and Relay | Accepted |
| [0002](0002-agent-is-security-boundary.md) | The Node Is the Security Boundary | Accepted |
| [0003](0003-outbound-only-agent-websocket.md) | Outbound-Only Node WebSocket (No Inbound Ports) | Accepted |
| [0004](0004-oauth-mcp-auth.md) | OAuth 2.0 as the MCP Client Authentication Standard | Accepted |
| [0005](0005-local-config-authority.md) | Node Config Is Local Authority; Relay Config Is Derived | Accepted |
| [0006](0006-agent-initiated-token-rotation.md) | Node-Initiated Token Rotation; Tokens Stored as Hashes | Accepted |
| [0007](0007-remove-broker-manage-scope.md) | Remove relay:manage Scope; Replace with Per-User RLS Filtering | Accepted |
| [0008](0008-admin-elevation-admin-until.md) | Admin Elevation via adminUntil on OauthSession (Not a Separate Token) | Accepted |
| [0009](0009-hub-nullable-user-id.md) | Hub Uses Nullable userId on ExecutorToken (Service-Level Token) | Accepted |
| [0010](0010-hub-three-tier-identity.md) | Three-Tier OS Identity Resolution for Hub | Accepted |
| [0011](0011-shared-label-discovery-optimistic.md) | Hub Share Discovery Is Optimistic (Not Authoritative) | Accepted |
| [0012](0012-in-memory-rate-limiting.md) | In-Memory Rate Limiting (No Redis for v1) | Accepted |
| [0013](0013-hub-restart-only-config.md) | Hub Config Changes Require Process Restart (No Live Reload) | Accepted |
| [0014](0014-subnode-worker-explicit-env.md) | Subnode Workers Get an Explicit, Minimal Environment (Never `process.env`) | Accepted |
| [0015](0015-bundle-prism-syntax-highlighting.md) | Bundle Prism.js for File Browser Syntax Highlighting | Accepted |
| [0016](0016-shared-queue-timeout.md) | Queue Timeout Utility Lives in `@constellation/shared`, Not Hub | Accepted |
| [0017](0017-ambiguous-share-resolution.md) | Ambiguous Share Resolution Returns an Error Instead of Requiring `host` | Accepted |
