# TODO

## MCP Tools

- [x] **Refine tool descriptions** — search tools (`grep_files`, `search_files`) and navigation tools (`list_directory`, `file_info`) are bleeding into each other in model tool selection. Tighten descriptions to make the distinctions clearer: `search_files` is filename pattern matching, `grep_files` is content search, `list_directory` is structure enumeration, `read_file` is content retrieval.

## Agent

- [x] **Deregister agent on stop** — when `constellation agent stop` is called (or the agent receives SIGTERM), send a deregistration message to the broker so it can immediately mark the agent offline rather than waiting for the heartbeat timeout (~3 minutes by default). Agents that disconnect without deregistering (crash, network loss) continue to rely on the heartbeat timeout.

- [ ] **MCP Tasks primitive** — implement Tasks support for long-running tools (`grep_files`, `search_files`, recursive `list_directory`) once the MCP SDK v2.x stable ships. See `packages/broker/implement-tasks.md` for the full implementation plan.

## Broker

- [ ] **Activity log** — surface structured logs through the broker UI: recent tool calls, errors, rate limit hits, and agent connection events per user. Requires a log storage layer (Postgres ring buffer or log aggregator integration).

- [ ] **Web UI** — management dashboard served by the broker. All actions are already available via `constellation broker` CLI; a web UI would be a convenience layer on top.

- [ ] **Horizontal scaling** — the in-memory WebSocket map means the broker can't scale beyond one instance without a shared connection layer (Redis pub/sub). Single instance is correct for now; isolate the connection map so it's replaceable later.

## Future / Deferred

- [ ] **Binary / media file reading** — `read_media_file` tool returning base64-encoded content with MIME type detection for images, audio, and other binary formats. Deferred pending a clearer use case.

- [ ] **Large file transfer (staging pattern)** — for binary transfers, the agent uploads to a short-lived pre-signed URL (S3/R2), MCP tool returns the URL. Keeps large payloads out of the model's context. Requires storage integration and token lifecycle management.

- [ ] **Multi-user shared agent** — a privileged parent agent spawns per-user sub-agents on shared machines (NAS, dev server). Parent receives RPC, looks up OS user via `user_mappings` config (OIDC sub → local username), spawns child under that user. Linux uses uid/gid spawn options; Windows uses S4U2Self token impersonation. macOS out of scope for this pattern.

- [ ] **Agent GUI** — graphical interface for agent management. All functionality accessible via CLI; GUI is a convenience layer.

- [ ] **MCP client connector documentation** — concrete setup examples for claude.ai, Cursor, and GitHub Copilot after further prototyping.

