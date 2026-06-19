# Architecture Decision Records

| # | Title | Status |
|---|---|---|
| [0001](0001-rpc-envelope-not-shared.md) | Do Not Share RpcEnvelope Across Agent and Broker | Accepted |
| [0002](0002-agent-is-security-boundary.md) | The Agent Is the Security Boundary | Accepted |
| [0003](0003-outbound-only-agent-websocket.md) | Outbound-Only Agent WebSocket (No Inbound Ports) | Accepted |
| [0004](0004-oauth-mcp-auth.md) | OAuth 2.0 as the MCP Client Authentication Standard | Accepted |
| [0005](0005-local-config-authority.md) | Agent Config Is Local Authority; Broker Config Is Derived | Accepted |
| [0006](0006-agent-initiated-token-rotation.md) | Agent-Initiated Token Rotation; Tokens Stored as Hashes | Accepted |
| [0007](0007-remove-broker-manage-scope.md) | Remove broker:manage Scope; Replace with Per-User RLS Filtering | Accepted |
| [0008](0008-admin-elevation-admin-until.md) | Admin Elevation via adminUntil on OauthSession (Not a Separate Token) | Accepted |
| [0009](0009-shared-agent-nullable-user-id.md) | Shared Agent Uses Nullable userId on AgentToken (Service-Level Token) | Accepted |
| [0010](0010-shared-agent-three-tier-identity.md) | Three-Tier OS Identity Resolution for Shared Agent | Accepted |
| [0011](0011-shared-label-discovery-optimistic.md) | Shared Label Discovery Is Optimistic (Not Authoritative) | Accepted |
| [0012](0012-in-memory-rate-limiting.md) | In-Memory Rate Limiting (No Redis for v1) | Accepted |
| [0013](0013-shared-agent-restart-only-config.md) | Shared Agent Config Changes Require Process Restart (No Live Reload) | Accepted |
| [0014](0014-subagent-worker-explicit-env.md) | Subagent Workers Get an Explicit, Minimal Environment (Never `process.env`) | Accepted |
| [0015](0015-bundle-prism-syntax-highlighting.md) | Bundle Prism.js for File Browser Syntax Highlighting | Accepted |
