# MCP Tasks Primitive — Broker Implementation Plan

## Context

The MCP spec version `2025-11-25` introduced an experimental **Tasks primitive** for long-running tool calls. Instead of blocking the MCP connection until a tool finishes, the server returns a `task_id` immediately. The client polls `tasks/get` for status and `tasks/result` when done. The server sends `notifications/progress` updates throughout.

This is the closest thing in the current spec to the "streaming response" model discussed earlier. True partial-result streaming (like Ollama token streaming) is still on the 2026 spec roadmap but not yet available.

**Why it matters here:** `grep_files`, `search_files`, and recursive `list_directory` can take multiple seconds on large trees. Today they block the MCP connection for up to `RPC_TIMEOUT_MS` (30s default). With Tasks, the client gets a handle immediately and polls — no long-held connection, no timeout cliff, and progress notifications give feedback while waiting.

---

## Current State

- Broker SDK: `@modelcontextprotocol/sdk` **v1.29.0** (stable) — no Tasks support
- Tasks require **v2.x** of the SDK
- v2.0-alpha.1+ exists; v2.0 stable was targeted for Q1 2026

**First action before any code:** Check whether `@modelcontextprotocol/sdk@2.x` stable has shipped and review its changelog for breaking changes.

```sh
npm info @modelcontextprotocol/sdk versions --json | tail -20
```

If only alpha versions exist, decide whether to pin to the latest alpha or wait. The plan below assumes v2.x (alpha or stable).

---

## Scope

Add Tasks support to the broker for the three expensive tools:
- `grep_files`
- `search_files`
- `list_directory` (recursive only — non-recursive is fast enough to stay synchronous)

All other tools remain synchronous (direct response, no task handle).

**Agent protocol: no changes.** The agent RPC remains synchronous request/response. The broker fires the RPC in the background and manages the task lifecycle on top of it. This is the simplest approach and avoids any agent-side work.

Progress notifications will be periodic "still processing" signals (no data payloads — the spec doesn't support that yet).

---

## Files to Modify

| File | Change |
|---|---|
| `packages/broker/package.json` | Bump `@modelcontextprotocol/sdk` to `^2.x` |
| `packages/broker/src/app.ts` | No change |
| `packages/broker/src/mcp.ts` | Main work: update server init, update three tool registrations |
| `packages/broker/src/hub.ts` | No change |
| `packages/broker/src/router.ts` | No change |
| `docs/broker.md` | Add Tasks section |

---

## Implementation

### 1. Upgrade the SDK

In `packages/broker/package.json`:
```json
"@modelcontextprotocol/sdk": "^2.0.0"
```

Then `pnpm install` and fix any type errors from breaking changes.

**Known v2.x breaking changes to watch for:**
- Task config moves to `capabilities.tasks` on `ServerOptions`
- `McpServer` constructor signature may change
- `StreamableHTTPServerTransport` API may have changed — verify the import path and constructor
- `registerTool` signature — confirm `inputSchema`/`outputSchema` still work the same way

### 2. Update `buildMcpServer()` in `mcp.ts`

Add a `TaskStore` to server construction. Use `InMemoryTaskStore` for now (single-process broker — no Redis needed):

```typescript
import { McpServer, InMemoryTaskStore } from "@modelcontextprotocol/sdk/server/mcp.js";

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "constellation", version: "0.1.0" },
    {
      capabilities: {
        tasks: { store: new InMemoryTaskStore() },
      },
    }
  );
  // ... register tools
}
```

Note: `InMemoryTaskStore` is scoped to a single server instance. Since the broker creates a new `McpServer` per request (stateless transport), tasks created in one request won't be retrievable in a subsequent poll from a different server instance. **This is a problem.**

**Fix:** Move the `TaskStore` outside `buildMcpServer()` and share it across instances:

```typescript
const sharedTaskStore = new InMemoryTaskStore();

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "constellation", version: "0.1.0" },
    { capabilities: { tasks: { store: sharedTaskStore } } }
  );
  ...
}
```

This works for a single-node broker. If the broker ever runs multi-instance, a persistent store (Redis or Postgres) would be needed — leave that as a `TODO` comment.

### 3. Update the three tool registrations in `mcp.ts`

The v2 SDK API for task-backed tools uses `server.experimental.tasks.registerToolTask`. The pattern:

```typescript
server.experimental.tasks.registerToolTask(
  "grep_files",
  {
    title: "Search File Contents",
    description: "...",
    inputSchema: { /* same as before */ },
    outputSchema: GrepFilesOutput,
    execution: { taskSupport: "optional" },  // client can opt in or get synchronous result
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    async createTask({ label, host, ...params }, extra) {
      const uid = userId(extra);
      // Fire and forget — agent RPC runs in background
      const resultPromise = dispatch(uid, "grep_files", label, params, host);
      return { initialStatus: "working" };
    },
    // SDK polls this until terminal state
    async getTaskResult(taskId, extra) {
      // The SDK + store handle this; we need to resolve resultPromise somehow
    }
  }
);
```

**The tricky part:** The SDK needs a way to connect the background work to the task result. The `InMemoryTaskStore` stores task metadata; we need to also store the in-flight promise. A thin wrapper around `InMemoryTaskStore` can hold a `Map<taskId, Promise<DispatchResult>>`:

```typescript
const pendingTaskResults = new Map<string, Promise<DispatchResult | RouterError>>();

// In createTask:
const resultPromise = dispatch(uid, tool, label, params, host);
pendingTaskResults.set(taskId, resultPromise);

// In getTaskResult:
const result = await pendingTaskResults.get(taskId);
pendingTaskResults.delete(taskId);
return result; // SDK maps this to the tool's outputSchema
```

Exact API calls depend on the v2 SDK surface — verify against the actual package after upgrade.

### 4. Progress notifications

During the background execution, send periodic progress pings so the client knows the task is alive. The SDK provides a way to push notifications from within a task handler. Likely via `extra.sendNotification` or a task context object:

```typescript
// Rough shape — verify exact API in v2 SDK
const interval = setInterval(() => {
  extra.sendNotification({
    method: "notifications/progress",
    params: {
      progressToken: extra.meta?.progressToken,
      progress: 0,         // no real progress info available without agent streaming
      message: "Searching...",
    },
  });
}, 3000);

resultPromise.finally(() => clearInterval(interval));
```

Since the agent RPC is opaque (we just wait for a response), progress is best-effort — the notification is "still running", not a percentage.

### 5. `list_directory` (recursive only)

For `list_directory`, Tasks should only kick in when `recursive: true`. One approach:

```typescript
execution: {
  taskSupport: ({ recursive }) => recursive ? "optional" : "forbidden",
}
```

Verify whether the v2 SDK supports a function for `taskSupport` or if it must be a static value. If static only, register two separate tools (`list_directory` synchronous + a `list_directory_recursive` with Tasks), or always use "optional" and let the client decide.

---

## Verification

After implementation:

1. **Build check:** `pnpm --filter @constellation/broker build` — no TypeScript errors.

2. **Sync tool still works:** Start the broker, connect an MCP client (or call `/mcp` directly with curl), call `list_hosts` — should return synchronously as before.

3. **Task flow:**
   - Call `grep_files` with a large directory. With a task-capable client, should get back `{ taskId: "...", status: "working" }`.
   - Poll `tasks/get { taskId }` — should return `working` while running.
   - Wait for completion; `tasks/result` should return the grep results.

4. **Progress notifications:** With a client that surfaces them, verify "Searching..." notifications arrive during a long grep.

5. **Non-task client fallback:** A client that doesn't send `task: { ttl }` in the `tools/call` request should still get a synchronous result (this is what `taskSupport: "optional"` provides).

6. **Shared store persistence:** Simulate two sequential HTTP requests by calling `tasks/get` after the `/mcp` connection that created the task has closed — the task should still be retrievable from `sharedTaskStore`.

---

## Risk / Notes

- **Experimental spec:** Tasks are marked experimental in `2025-11-25`. The SDK API may shift in v2.x stable.
- **Client support:** Claude.ai, Cursor, and Copilot may not yet poll `tasks/get`. The `taskSupport: "optional"` flag ensures they still get synchronous results — no regression for unsupported clients.
- **In-memory store:** `sharedTaskStore` is ephemeral — broker restarts clear all in-flight tasks. Acceptable for now; document it.
- **No agent streaming:** Progress notifications are heartbeats only. Actual partial-result streaming (chunks of grep output) requires agent-side changes and waits for the spec's "Streamed results" feature.
