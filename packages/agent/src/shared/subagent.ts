import { fork, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLogger } from "@constellation/shared";
import type { ResolvedIdentity } from "./identity.js";
import type { SharedAgentConfig } from "./config.js";

const log = createLogger("agent:subagent-pool");

// ---------------------------------------------------------------------------
// IPC message types (parent side)
// ---------------------------------------------------------------------------

interface SubagentInit {
  type: "init";
  labels: Record<string, string>;
  max_file_size_kb: number;
}

interface SubagentRequest {
  type: "request";
  request_id: string;
  tool: string;
  label: string;
  params: unknown;
}

interface SubagentReady {
  type: "ready";
}

interface SubagentResponse {
  type: "response";
  request_id: string;
  result?: unknown;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  child: ChildProcess;
  username: string;
  ready: boolean;
  /** Callbacks waiting for SubagentReady */
  readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  /** Pending RPCs awaiting a SubagentResponse */
  pending: Map<string, { resolve: (r: SubagentResponse) => void; reject: (e: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// UID restriction checks
// ---------------------------------------------------------------------------

function checkUidRestrictions(uid: number, cfg: SharedAgentConfig): string | null {
  if (uid === 0) return "UID 0 (root) is always blocked";

  const agentUid = userInfo().uid;
  if (uid === agentUid) return `UID ${uid} matches the shared agent process UID — subagents cannot run as the agent itself`;

  const { allowed_range, blocked_range, blocked_uids } = cfg.subagent_uid;

  if (blocked_uids && blocked_uids.includes(uid)) {
    return `UID ${uid} is explicitly blocked`;
  }

  if (blocked_range) {
    const { min = 0, max = Infinity } = blocked_range;
    if (uid >= min && uid <= max) {
      return `UID ${uid} falls within blocked range [${min}, ${max}]`;
    }
  }

  if (allowed_range) {
    const { min = 0, max = Infinity } = allowed_range;
    if (uid < min || uid > max) {
      return `UID ${uid} is outside allowed range [${min}, ${max}]`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

/**
 * Builds an explicit, minimal environment for the forked subagent worker.
 *
 * Deliberately does NOT spread `process.env`: the parent process holds
 * CONSTELLATION_AGENT_TOKEN (and possibly other secrets sourced from env_file),
 * and the worker immediately drops privileges to an arbitrary, possibly
 * low-trust local user. That user can read their own process's
 * /proc/<pid>/environ, so any secret present here would leak to them. If the
 * worker ever needs a new variable, add it explicitly below — do not widen
 * this to a spread of process.env. See ADR 0014 and docs/shared-agent.md
 * ("Token security").
 */
function buildWorkerEnv(identity: ResolvedIdentity): NodeJS.ProcessEnv {
  const { username, uid, gid, home } = identity;

  const env: NodeJS.ProcessEnv = {
    CONSTELLATION_TARGET_USER: username,
    CONSTELLATION_TARGET_UID: String(uid),
    CONSTELLATION_TARGET_GID: String(gid),
    // HOME/USER/LOGNAME reflect the *target* user, not the agent's service
    // account — running with the agent's HOME would point libraries at the
    // wrong (and inaccessible) home directory once privileges are dropped.
    HOME: home,
    USER: username,
    LOGNAME: username,
  };

  if (process.env["PATH"] !== undefined) env["PATH"] = process.env["PATH"];
  if (process.env["LOG_LEVEL"] !== undefined) env["LOG_LEVEL"] = process.env["LOG_LEVEL"];

  return env;
}

// ---------------------------------------------------------------------------
// SubagentPool
// ---------------------------------------------------------------------------

export interface DispatchResult {
  result?: unknown;
  error?: unknown;
}

export type DispatchError =
  | { kind: "uid_blocked"; message: string }
  | { kind: "spawn_failed"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "worker_error"; message: string };

export function isDispatchError(v: DispatchResult | DispatchError): v is DispatchError {
  return "kind" in v;
}

// In a pkg binary the worker is placed at shared/subagent-worker.cjs next to the binary.
const workerPath = (process as { pkg?: unknown }).pkg
  ? join(dirname(process.execPath), "shared", "subagent-worker.cjs")
  : join(dirname(fileURLToPath(import.meta.url)), "subagent-worker.cjs");

export class SubagentPool {
  private pool = new Map<string, PoolEntry>();
  private shuttingDown = false;
  private readonly cfg: SharedAgentConfig;
  private readonly labelRegistry: Record<string, string>;

  constructor(cfg: SharedAgentConfig, labelRegistry: Record<string, string>) {
    this.cfg = cfg;
    this.labelRegistry = labelRegistry;
  }

  async dispatch(
    identity: ResolvedIdentity,
    tool: string,
    label: string,
    params: unknown,
    requestId: string
  ): Promise<DispatchResult | DispatchError> {
    if (this.shuttingDown) {
      return { kind: "worker_error", message: "AGENT_SHUTTING_DOWN — retry after 45 seconds" };
    }

    // UID restriction checks before every spawn
    const restriction = checkUidRestrictions(identity.uid, this.cfg);
    if (restriction) {
      log.warn({ username: identity.username, uid: identity.uid, restriction }, "UID blocked");
      return { kind: "uid_blocked", message: restriction };
    }

    let entry = this.pool.get(identity.username);

    if (!entry) {
      const spawnResult = await this.spawn(identity);
      if ("kind" in spawnResult) return spawnResult;
      entry = spawnResult;
    }

    // Send the request
    return this.sendRequest(entry, identity.username, tool, label, params, requestId);
  }

  private async spawn(identity: ResolvedIdentity): Promise<PoolEntry | DispatchError> {
    const { username, uid, gid } = identity;

    log.info({ username, uid }, "Spawning subagent worker");

    let child: ChildProcess;
    try {
      child = fork(workerPath, [], {
        env: buildWorkerEnv(identity),
        // Do NOT pass uid/gid fork options — the worker drops privileges itself
        // after calling initgroups(), which requires capabilities still set on spawn.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (err) {
      log.error({ err, username }, "Failed to fork subagent worker");
      return { kind: "spawn_failed", message: `Failed to spawn subagent for '${username}': ${(err as Error).message}` };
    }

    const entry: PoolEntry = {
      child,
      username,
      ready: false,
      readyWaiters: [],
      pending: new Map(),
      idleTimer: null,
    };

    this.pool.set(username, entry);
    this.wireChildHandlers(entry);

    // Send init and wait for ready
    const initMsg: SubagentInit = {
      type: "init",
      labels: this.labelRegistry,
      max_file_size_kb: 100,
    };
    child.send(initMsg);

    const readyResult = await this.waitForReady(entry);
    if (readyResult !== null) return readyResult;

    return entry;
  }

  /** Resolves null on success, or a DispatchError on failure */
  private waitForReady(entry: PoolEntry): Promise<null | DispatchError> {
    const timeoutMs = this.cfg.subagent_rpc_timeout_seconds * 1000;

    return new Promise<null | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        entry.readyWaiters = entry.readyWaiters.filter((w) => w.resolve !== innerResolve);
        this.terminateEntry(entry.username, "ready timeout");
        resolve({ kind: "spawn_failed", message: `Subagent for '${entry.username}' did not signal ready within ${timeoutMs}ms` });
      }, timeoutMs);

      function innerResolve(): void {
        clearTimeout(timer);
        resolve(null);
      }

      entry.readyWaiters.push({
        resolve: innerResolve,
        reject: (e) => {
          clearTimeout(timer);
          resolve({ kind: "spawn_failed", message: e.message });
        },
      });
    });
  }

  private async sendRequest(
    entry: PoolEntry,
    username: string,
    tool: string,
    label: string,
    params: unknown,
    requestId: string
  ): Promise<DispatchResult | DispatchError> {
    const timeoutMs = this.cfg.subagent_rpc_timeout_seconds * 1000;

    const msg: SubagentRequest = { type: "request", request_id: requestId, tool, label, params };

    return new Promise<DispatchResult | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(requestId);
        this.terminateEntry(username, "RPC timeout");
        resolve({ kind: "timeout", message: `Subagent for '${username}' did not respond within ${timeoutMs}ms` });
      }, timeoutMs);

      entry.pending.set(requestId, {
        resolve: (resp) => {
          clearTimeout(timer);
          this.resetIdleTimer(username);
          resolve({ result: resp.result, error: resp.error });
        },
        reject: (e) => {
          clearTimeout(timer);
          resolve({ kind: "worker_error", message: e.message });
        },
      });

      if (!entry.child.send(msg)) {
        clearTimeout(timer);
        entry.pending.delete(requestId);
        resolve({ kind: "worker_error", message: `IPC send failed for '${username}'` });
      }
    });
  }

  private wireChildHandlers(entry: PoolEntry): void {
    const { child, username } = entry;

    child.on("message", (rawMsg: unknown) => {
      const msg = rawMsg as SubagentReady | SubagentResponse;

      if (msg.type === "ready") {
        entry.ready = true;
        for (const w of entry.readyWaiters) w.resolve();
        entry.readyWaiters = [];
        this.resetIdleTimer(username);
        return;
      }

      if (msg.type === "response") {
        const waiter = entry.pending.get(msg.request_id);
        if (!waiter) {
          log.error({ username, request_id: msg.request_id }, "Received response for unknown request_id — terminating subagent");
          this.terminateEntry(username, "unknown request_id");
          return;
        }
        entry.pending.delete(msg.request_id);
        waiter.resolve(msg);
        return;
      }

      log.error({ username, msg }, "Received unknown message from subagent — terminating");
      this.terminateEntry(username, "unknown message type");
    });

    child.on("exit", (code, signal) => {
      log.info({ username, code, signal }, "Subagent worker exited");
      this.handleWorkerExit(username, `exited with code=${code} signal=${signal}`);
    });

    child.on("error", (err) => {
      log.error({ err, username }, "Subagent worker process error");
      this.handleWorkerExit(username, err.message);
    });
  }

  private handleWorkerExit(username: string, reason: string): void {
    const entry = this.pool.get(username);
    if (!entry) return;

    this.clearIdleTimer(username);
    this.pool.delete(username);

    const err = new Error(`Subagent for '${username}' died: ${reason}`);

    for (const w of entry.readyWaiters) w.reject(err);
    for (const w of entry.pending.values()) w.reject(err);
  }

  private resetIdleTimer(username: string): void {
    const entry = this.pool.get(username);
    if (!entry) return;

    this.clearIdleTimer(username);

    const timeoutSec = this.cfg.subagent_idle_timeout_seconds;

    if (timeoutSec === 0) {
      // No pooling — terminate immediately when all in-flight RPCs complete
      if (entry.pending.size === 0) {
        this.terminateEntry(username, "no-pool mode");
      }
      return;
    }

    entry.idleTimer = setTimeout(() => {
      if (entry.pending.size === 0) {
        log.info({ username }, "Subagent idle timeout — terminating");
        this.terminateEntry(username, "idle timeout");
      }
    }, timeoutSec * 1000);
  }

  private clearIdleTimer(username: string): void {
    const entry = this.pool.get(username);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private terminateEntry(username: string, reason: string): void {
    const entry = this.pool.get(username);
    if (!entry) return;

    this.clearIdleTimer(username);
    this.pool.delete(username);

    log.info({ username, reason }, "Terminating subagent worker");
    try { entry.child.kill("SIGTERM"); } catch { /* already dead */ }

    // Reject any remaining pending requests
    const err = new Error(`Subagent terminated: ${reason}`);
    for (const w of entry.readyWaiters) w.reject(err);
    for (const w of entry.pending.values()) w.reject(err);
  }

  /**
   * Graceful shutdown: reject new RPCs, drain in-flight requests (up to
   * drainTimeoutMs), then terminate all workers.
   */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this.shuttingDown = true;

    // Immediately terminate idle workers (no in-flight RPCs).
    // Snapshot first — terminateEntry deletes from the pool during iteration.
    for (const [username, entry] of [...this.pool]) {
      if (entry.pending.size === 0) {
        this.terminateEntry(username, "shutdown");
      }
    }

    if (this.pool.size === 0) return;

    // For workers with in-flight RPCs, wait for their pending requests to settle
    const drainPromise = new Promise<void>((resolve) => {
      const check = (): void => {
        const allDone = [...this.pool.values()].every((e) => e.pending.size === 0);
        if (allDone) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    await Promise.race([
      drainPromise,
      new Promise<void>((r) => setTimeout(r, drainTimeoutMs)),
    ]);

    // Force-kill whatever remains
    for (const [username] of [...this.pool]) {
      this.terminateEntry(username, "drain timeout");
    }
  }
}
