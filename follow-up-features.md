# Constellation — Follow-up Features

---

## Agent Lifecycle

- [ ] **Deregister agent on stop** — when `constellation agent stop` is called (or the agent receives SIGTERM), send a deregistration message to the broker so it can immediately mark the agent offline rather than waiting for the heartbeat timeout (~3 minutes by default). The broker should remove the agent from the in-memory connection map and update `last_heartbeat_at` to signal offline state. Agents that disconnect without deregistering (crash, network loss) continue to rely on the heartbeat timeout.
