import { fork, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLogger } from "@constellation/shared";
import { getGroupIds, type ResolvedIdentity } from "./identity.js";
import type { HubConfig } from "./config.js";

const log = createLogger("hub:subnode-pool");

// ---------------------------------------------------------------------------
// IPC message types (parent side)
// ---------------------------------------------------------------------------

interface SubnodeInit {
  type: "init";
  labels: Record<string, string>;
  max_file_size_kb: number;
}

interface SubnodeRequest {
  type: "request";
  request_id: string;
  tool: string;
  label: string;
  params: unknown;
}

interface SubnodeReady {
  type: "ready";
}

interface SubnodeResponse {
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
  /** Callbacks waiting for SubnodeReady */
  readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  /** Pending RPCs awaiting a SubnodeResponse */
  pending: Map<string, { resolve: (r: SubnodeResponse) => void; reject: (e: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// UID restriction checks
// ---------------------------------------------------------------------------

export function checkUidRestrictions(uid: number, cfg: HubConfig): string | null {
  if (uid === 0) return "UID 0 (root) is always blocked";

  const hubUid = userInfo().uid;
  if (uid === hubUid) return `UID ${uid} matches the hub process UID — subnodes cannot run as the hub itself`;

  const { allowed_range, blocked_range, blocked_uids } = cfg.subnode_uid;

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
// GID restriction checks
// ---------------------------------------------------------------------------

/**
 * Checks the target user's full group membership — primary plus supplementary,
 * resolved the same way initgroups() will apply it when the worker drops
 * privileges — against an always-blocked set (root's group, the hub's
 * own group) and the admin-configured blocklist.
 *
 * checkUidRestrictions can reject a single bad UID outright; group membership
 * doesn't have an equivalent single value to gate on; a user can be a member of
 * many groups, any one of which (e.g. `docker`, `sudo`, a group that owns
 * sensitive files outside any label) could grant the subnode privileges the
 * admin never intended. So instead of trying to run with a *trimmed* group
 * list (which would mean replacing initgroups() with a hand-rolled setgroups()
 * call — see ADR 0014), we resolve the full set up front and refuse to spawn at
 * all if any member is on the blocked list.
 *
 * The full list of blocked groups is logged for the administrator (keyed by
 * request_id so they have a starting point to investigate), but the message
 * returned to the caller intentionally says only that *some* group is blocked —
 * never which one(s) — so a user can't use this signal to enumerate group
 * membership of accounts they don't control.
 */
async function checkGidRestrictions(
  identity: ResolvedIdentity,
  cfg: HubConfig,
  requestId: string
): Promise<DispatchError | null> {
  const groups = await getGroupIds(identity.username);
  if (groups === null) {
    log.error(
      { username: identity.username, uid: identity.uid, request_id: requestId },
      "Failed to resolve group membership for subnode user — refusing to spawn"
    );
    return {
      kind: "spawn_failed",
      message: `Could not verify group membership for this account. Contact your administrator with reference ID: ${requestId}`,
    };
  }

  const hubGid = userInfo().gid;
  const blocked = new Set<number>([0, hubGid, ...(cfg.subnode_gid.blocked_gids ?? [])]);
  const hits = groups.filter((g) => blocked.has(g));

  if (hits.length > 0) {
    log.warn(
      {
        username: identity.username,
        uid: identity.uid,
        request_id: requestId,
        blocked_groups: hits,
      },
      "Subnode spawn blocked — user belongs to one or more blocked groups"
    );
    return {
      kind: "gid_blocked",
      message: `Access denied: one or more of your OS groups are blocked by the hub administrator. Contact your administrator with reference ID: ${requestId}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

/**
 * Builds an explicit, minimal environment for the forked subnode worker.
 *
 * Deliberately does NOT spread `process.env`: the parent process holds
 * CONSTELLATION_HUB_TOKEN (and possibly other secrets sourced from env_file),
 * and the worker immediately drops privileges to an arbitrary, possibly
 * low-trust local user. That user can read their own process's
 * /proc/<pid>/environ, so any secret present here would leak to them. If the
 * worker ever needs a new variable, add it explicitly below — do not widen
 * this to a spread of process.env. See ADR 0014 and docs/hub.md
 * ("Token security").
 */
function buildWorkerEnv(identity: ResolvedIdentity): NodeJS.ProcessEnv {
  const { username, uid, gid, home } = identity;

  const env: NodeJS.ProcessEnv = {
    CONSTELLATION_TARGET_USER: username,
    CONSTELLATION_TARGET_UID: String(uid),
    CONSTELLATION_TARGET_GID: String(gid),
    // HOME/USER/LOGNAME reflect the *target* user, not the hub's service
    // account — running with the hub's HOME would point libraries at the
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
// SubnodePool
// ---------------------------------------------------------------------------

export interface DispatchResult {
  result?: unknown;
  error?: unknown;
}

export type DispatchError =
  | { kind: "uid_blocked"; message: string }
  | { kind: "gid_blocked"; message: string }
  | { kind: "spawn_failed"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "worker_error"; message: string };

export function isDispatchError(v: DispatchResult | DispatchError): v is DispatchError {
  return "kind" in v;
}

// In a pkg binary the worker is placed at hub/subnode-worker.cjs next to the binary.
const workerPath = (process as { pkg?: unknown }).pkg
  ? join(dirname(process.execPath), "hub", "subnode-worker.cjs")
  : join(dirname(fileURLToPath(import.meta.url)), "subnode-worker.cjs");

export class SubnodePool {
  private pool = new Map<string, PoolEntry>();
  private shuttingDown = false;
  private readonly cfg: HubConfig;
  private readonly labelRegistry: Record<string, string>;

  constructor(cfg: HubConfig, labelRegistry: Record<string, string>) {
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
      return { kind: "worker_error", message: "HUB_SHUTTING_DOWN — retry after 45 seconds" };
    }

    // UID restriction checks before every spawn
    const restriction = checkUidRestrictions(identity.uid, this.cfg);
    if (restriction) {
      log.warn({ username: identity.username, uid: identity.uid, restriction }, "UID blocked");
      return { kind: "uid_blocked", message: restriction };
    }

    // GID restriction checks — group membership is resolved fresh on every
    // dispatch (not just at spawn) so changes to a user's groups take effect
    // without waiting for their pooled worker to be torn down.
    const gidBlock = await checkGidRestrictions(identity, this.cfg, requestId);
    if (gidBlock) return gidBlock;

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
    const { username, uid } = identity;

    log.info({ username, uid }, "Spawning subnode worker");

    let child: ChildProcess;
    try {
      child = fork(workerPath, [], {
        env: buildWorkerEnv(identity),
        // Do NOT pass uid/gid fork options — the worker drops privileges itself
        // after calling initgroups(), which requires capabilities still set on spawn.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (err) {
      log.error({ err, username }, "Failed to fork subnode worker");
      return { kind: "spawn_failed", message: `Failed to spawn subnode for '${username}': ${(err as Error).message}` };
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
    const initMsg: SubnodeInit = {
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
    const timeoutMs = this.cfg.subnode_rpc_timeout_seconds * 1000;

    return new Promise<null | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        entry.readyWaiters = entry.readyWaiters.filter((w) => w.resolve !== innerResolve);
        this.terminateEntry(entry.username, "ready timeout");
        resolve({ kind: "spawn_failed", message: `Subnode for '${entry.username}' did not signal ready within ${timeoutMs}ms` });
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
    const timeoutMs = this.cfg.subnode_rpc_timeout_seconds * 1000;

    const msg: SubnodeRequest = { type: "request", request_id: requestId, tool, label, params };

    return new Promise<DispatchResult | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(requestId);
        this.terminateEntry(username, "RPC timeout");
        resolve({ kind: "timeout", message: `Subnode for '${username}' did not respond within ${timeoutMs}ms` });
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
      const msg = rawMsg as SubnodeReady | SubnodeResponse;

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
          log.error({ username, request_id: msg.request_id }, "Received response for unknown request_id — terminating subnode");
          this.terminateEntry(username, "unknown request_id");
          return;
        }
        entry.pending.delete(msg.request_id);
        waiter.resolve(msg);
        return;
      }

      log.error({ username, msg }, "Received unknown message from subnode — terminating");
      this.terminateEntry(username, "unknown message type");
    });

    child.on("exit", (code, signal) => {
      log.info({ username, code, signal }, "Subnode worker exited");
      this.handleWorkerExit(username, `exited with code=${code} signal=${signal}`);
    });

    child.on("error", (err) => {
      log.error({ err, username }, "Subnode worker process error");
      this.handleWorkerExit(username, err.message);
    });
  }

  private handleWorkerExit(username: string, reason: string): void {
    const entry = this.pool.get(username);
    if (!entry) return;

    this.clearIdleTimer(username);
    this.pool.delete(username);

    const err = new Error(`Subnode for '${username}' died: ${reason}`);

    for (const w of entry.readyWaiters) w.reject(err);
    for (const w of entry.pending.values()) w.reject(err);
  }

  private resetIdleTimer(username: string): void {
    const entry = this.pool.get(username);
    if (!entry) return;

    this.clearIdleTimer(username);

    const timeoutSec = this.cfg.subnode_idle_timeout_seconds;

    if (timeoutSec === 0) {
      // No pooling — terminate immediately when all in-flight RPCs complete
      if (entry.pending.size === 0) {
        this.terminateEntry(username, "no-pool mode");
      }
      return;
    }

    entry.idleTimer = setTimeout(() => {
      if (entry.pending.size === 0) {
        log.info({ username }, "Subnode idle timeout — terminating");
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

    log.info({ username, reason }, "Terminating subnode worker");
    try { entry.child.kill("SIGTERM"); } catch { /* already dead */ }

    // Reject any remaining pending requests
    const err = new Error(`Subnode terminated: ${reason}`);
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
