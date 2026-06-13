# ADR 0003: Outbound-Only Node WebSocket (No Inbound Ports)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The node runs on the user's local machine — behind a firewall, NAT, or VPN — and
needs to communicate with the relay, which is publicly accessible. An early design
question was whether the relay should initiate connections to nodes or nodes should
initiate connections to the relay.

## Decision

Nodes connect outbound to the relay over a persistent WebSocket. The relay never
initiates connections to nodes. The node exposes no inbound ports.

The node connects to `wss://<relay>/agent/connect` on startup, authenticates with
its agent token, and holds that connection open. All communication flows through this
relay-held connection. The in-memory connection map (`agent_id → WebSocket`) on the
relay is the sole state for routing RPCs to a connected node.

## Rationale

An inbound port on the node would require the node host to be publicly addressable
(or reachable via port forwarding), have a stable IP or domain, and expose a firewall
surface. The outbound WebSocket model eliminates all three requirements. The relay is
the only component that needs a public address.

This also simplifies reconnection: since the node initiates, reconnect logic lives
entirely in the node and needs no coordination with the relay beyond token validation.
Reconnection is stateless — no handshake, no re-delivery of config, just token
validation followed by a `config_update` push.

## Alternatives Considered

**Relay-initiated SSH or reverse tunnel:** would require key management, stable
node addressing, and more complex authentication. Rejected.

**Long-polling HTTP:** possible but less efficient for the RPC pattern and more complex
to implement bidirectionally. WebSocket is the natural fit for MCP's message-passing
model.

## Consequences

- The node must run continuously (as a service) to be reachable. Liveness is tracked
  by the relay via WebSocket pings (`HEARTBEAT_INTERVAL_SECONDS`, default 60s).
  After `HEARTBEAT_MAX_MISSED` (default 3) consecutive missed pongs, the relay
  terminates the connection.
- Node reconnection uses exponential backoff (1s initial, 2× multiplier, ±20% jitter,
  60s cap) and retries indefinitely.
- The node enforces TLS: it refuses to transmit its token to any non-localhost host
  over an unencrypted connection (`http://` or `ws://`). The agent token is a
  long-lived credential.
- The relay's in-memory connection map is the scaling bottleneck for horizontal
  scaling. It is deliberately isolated behind a clean interface so the map can be
  replaced with a Redis pub/sub layer when multi-instance is needed.
