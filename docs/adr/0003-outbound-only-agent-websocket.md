# ADR 0003: Outbound-Only Agent WebSocket (No Inbound Ports)

**Status:** Accepted  
**Date:** 2026-06-06

## Context

The agent runs on the user's local machine — behind a firewall, NAT, or VPN — and
needs to communicate with the broker, which is publicly accessible. An early design
question was whether the broker should initiate connections to agents or agents should
initiate connections to the broker.

## Decision

Agents connect outbound to the broker over a persistent WebSocket. The broker never
initiates connections to agents. The agent exposes no inbound ports.

The agent connects to `wss://<broker>/agent/connect` on startup, authenticates with
its agent token, and holds that connection open. All communication flows through this
broker-held connection. The in-memory connection map (`agent_id → WebSocket`) on the
broker is the sole state for routing RPCs to a connected agent.

## Rationale

An inbound port on the agent would require the agent host to be publicly addressable
(or reachable via port forwarding), have a stable IP or domain, and expose a firewall
surface. The outbound WebSocket model eliminates all three requirements. The broker is
the only component that needs a public address.

This also simplifies reconnection: since the agent initiates, reconnect logic lives
entirely in the agent and needs no coordination with the broker beyond token validation.
Reconnection is stateless — no handshake, no re-delivery of config, just token
validation followed by a `config_update` push.

## Alternatives Considered

**Broker-initiated SSH or reverse tunnel:** would require key management, stable
agent addressing, and more complex authentication. Rejected.

**Long-polling HTTP:** possible but less efficient for the RPC pattern and more complex
to implement bidirectionally. WebSocket is the natural fit for MCP's message-passing
model.

## Consequences

- The agent must run continuously (as a service) to be reachable. Liveness is tracked
  by the broker via WebSocket pings (`HEARTBEAT_INTERVAL_SECONDS`, default 60s).
  After `HEARTBEAT_MAX_MISSED` (default 3) consecutive missed pongs, the broker
  terminates the connection.
- Agent reconnection uses exponential backoff (1s initial, 2× multiplier, ±20% jitter,
  60s cap) and retries indefinitely.
- The agent enforces TLS: it refuses to transmit its token to any non-localhost host
  over an unencrypted connection (`http://` or `ws://`). The agent token is a
  long-lived credential.
- The broker's in-memory connection map is the scaling bottleneck for horizontal
  scaling. It is deliberately isolated behind a clean interface so the map can be
  replaced with a Redis pub/sub layer when multi-instance is needed.
