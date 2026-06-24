import { fork, type ChildProcess } from "node:child_process";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLogger } from "@constellation/shared";
import { getGroupIds, type ResolvedIdentity } from "./identity.js";
import { resolveQueueTimeoutMs, type HubConfig } from "./config.js";

const log = createLogger("hub:subnode-pool");

// ---------------------------------------------------------------------------
// IPC message types (parent side)
// ---------------------------------------------------------------------------

interface SubnodeInit {
  type: "init";
  shares: Record<string, string>;
  max_file_size_kb: number;
}

interface SubnodeRequest {
  type: "request";
  request_id: string;
  tool: string;
  share: string;
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
// Data model
// ---------------------------------------------------------------------------

interface Worker {
  child: ChildProcess;
  ready: boolean;
  readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  pending: Map<string, { resolve: (r: SubnodeResponse) => void; reject: (e: Error) => void }>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Fixed at spawn time: "warm" if spawned within the min floor, "burst" if beyond. */
  tier: "warm" | "burst";
  /** OS identity this worker was spawned (and privilege-dropped) for — fixed for the
   *  process's entire life since setuid/setgid can't be re-applied. Used to detect uid/gid
   *  drift (e.g. account deletion + uid reuse) so a stale worker is never reused for a
   *  freshly-resolved identity it no longer matches. */
  uid: number;
  gid: number;
}

interface QueuedRequest {
  tool: string;
  share: string;
  params: unknown;
  requestId: string;
  resolve: (r: DispatchResult | DispatchError) => void;
  /** Date.now() + resolveQueueTimeoutMs(cfg), set at enqueue time. */
  deadline: number;
}

interface Subnode {
  username: string;
  workers: Worker[];
  queue: QueuedRequest[];
  /** Serializes "pick / spawn / enqueue" decisions for this user without serializing IPC round-trips. */
  lock: Promise<void>;
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
 * sensitive files outside any share) could grant the subnode privileges the
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
  | { kind: "worker_error"; message: string }
  | { kind: "subnode_limit"; message: string };

export function isDispatchError(v: DispatchResult | DispatchError): v is DispatchError {
  return "kind" in v;
}

// In a pkg binary the worker is placed at hub/subnode-worker.cjs next to the binary.
const workerPath = (process as { pkg?: unknown }).pkg
  ? join(dirname(process.execPath), "hub", "subnode-worker.cjs")
  : join(dirname(fileURLToPath(import.meta.url)), "subnode-worker.cjs");

/**
 * Grace period after SIGTERM before the parent escalates to SIGKILL.
 *
 * The worker is expected to self-terminate well within this window on its
 * own (see SHUTDOWN_GRACE_MS in subnode-worker.ts, which now also falls back
 * to a self-SIGKILL rather than process.exit() — confirmed by direct test
 * that process.exit() can hang the main thread indefinitely, rather than
 * just fail, when a hang is a blocked fs call parked on a libuv threadpool
 * thread). This is the parent-side backstop for the cases that self-exit
 * can't cover: a worker killed before its handlers ever installed, or one
 * that's wedged hard enough that no JS in it — including its own SIGKILL
 * fallback — ever gets to run.
 */
export const FORCE_KILL_GRACE_MS = 15_000;

export class SubnodePool {
  private subnodes = new Map<string, Subnode>();
  private shuttingDown = false;
  private readonly cfg: HubConfig;
  private readonly shareRegistry: Record<string, string>;

  constructor(cfg: HubConfig, shareRegistry: Record<string, string>) {
    this.cfg = cfg;
    this.shareRegistry = shareRegistry;
  }

  async dispatch(
    identity: ResolvedIdentity,
    tool: string,
    share: string,
    params: unknown,
    requestId: string
  ): Promise<DispatchResult | DispatchError> {
    if (this.shuttingDown) {
      return { kind: "worker_error", message: "HUB_SHUTTING_DOWN — retry after 45 seconds" };
    }

    const restriction = checkUidRestrictions(identity.uid, this.cfg);
    if (restriction) {
      // `restriction` (the specific rule that matched) is internal detail for
      // operators only — it discloses configured UID range bounds and the hub's
      // own service-account UID. Log it in full here, but never echo it into
      // the message that crosses the trust boundary to the RPC caller below
      // (same pattern as removeWorker's `reason` — see SECURITY-2).
      log.warn({ username: identity.username, uid: identity.uid, restriction, request_id: requestId }, "UID blocked");
      this.evictSubnodeWorkers(identity.username, "uid newly blocked by policy");
      return {
        kind: "uid_blocked",
        message: `Access denied: your account is not permitted to use this hub. Contact your administrator with reference ID: ${requestId}`,
      };
    }

    // GID restriction checks — group membership is resolved fresh on every
    // dispatch (not just at spawn), and a block now also evicts any already-warm
    // workers for this user (see evictSubnodeWorkers) instead of only gating new
    // spawns — so revocation takes effect immediately, not just once the pooled
    // worker happens to idle out.
    const gidBlock = await checkGidRestrictions(identity, this.cfg, requestId);
    if (gidBlock) {
      this.evictSubnodeWorkers(identity.username, "gid newly blocked by policy");
      return gidBlock;
    }

    let subnode = this.subnodes.get(identity.username);
    if (!subnode) {
      // max_concurrent_subnodes (0 = unlimited) bounds total distinct identities, independent
      // of subnode_workers.max which only bounds workers *per* identity — see HubConfig for
      // why this only gates new identities, not further requests from ones already tracked.
      const limit = this.cfg.max_concurrent_subnodes;
      if (limit > 0 && this.subnodes.size >= limit) {
        return {
          kind: "subnode_limit",
          message: "Hub is at capacity for the number of distinct users it can serve concurrently. Please try again shortly.",
        };
      }
      subnode = { username: identity.username, workers: [], queue: [], lock: Promise.resolve() };
      this.subnodes.set(identity.username, subnode);
    }

    return this.assignAndSend(subnode, identity, tool, share, params, requestId);
  }

  /**
   * Serializes the "pick / spawn / enqueue" decision for this user via
   * subnode.lock, then resolves the result independently once the IPC
   * round-trip finishes. Awaiting the spawn inside the lock prevents two
   * concurrent dispatches from both deciding to spawn and racing to be
   * "worker #1".
   */
  private assignAndSend(
    subnode: Subnode,
    identity: ResolvedIdentity,
    tool: string,
    share: string,
    params: unknown,
    requestId: string
  ): Promise<DispatchResult | DispatchError> {
    let resultResolve!: (r: DispatchResult | DispatchError) => void;
    const result = new Promise<DispatchResult | DispatchError>((resolve) => {
      resultResolve = resolve;
    });

    subnode.lock = subnode.lock.then(async () => {
      // A worker's OS credentials are fixed forever at spawn time (setuid/setgid can't be
      // re-applied later). If this username has since re-resolved to a different uid/gid
      // (e.g. the account was deleted and recreated with a recycled uid), any existing idle
      // worker is running under the WRONG identity and must never be handed this request.
      for (const stale of subnode.workers.filter(
        (w) => w.pending.size === 0 && (w.uid !== identity.uid || w.gid !== identity.gid)
      )) {
        this.removeWorker(subnode, stale, "identity uid/gid changed since this worker was spawned");
      }
      // removeWorker deletes the subnode from the pool map once its last worker is gone —
      // re-register it so a worker spawned below isn't orphaned from the pool.
      this.subnodes.set(identity.username, subnode);

      const idleWorker = subnode.workers.find((w) => w.ready && w.pending.size === 0);
      if (idleWorker) {
        void this.sendRequest(subnode, idleWorker, tool, share, params, requestId).then(resultResolve);
        return;
      }

      if (subnode.workers.length < this.cfg.subnode_workers.max) {
        const tier: "warm" | "burst" =
          subnode.workers.length < this.cfg.subnode_workers.min ? "warm" : "burst";
        const spawnResult = await this.spawnWorker(subnode, identity, tier);
        if (spawnResult.ok !== true) {
          resultResolve(spawnResult);
          return;
        }
        const newWorker = spawnResult.worker;
        subnode.workers.push(newWorker);
        void this.sendRequest(subnode, newWorker, tool, share, params, requestId).then(resultResolve);
        return;
      }

      // At capacity — queue, bounded by the resolved queue timeout
      const queueTimeoutMs = resolveQueueTimeoutMs(this.cfg);
      subnode.queue.push({
        tool, share, params, requestId,
        resolve: resultResolve,
        deadline: Date.now() + queueTimeoutMs,
      });
    }).catch((e: unknown) => {
      // An unexpected throw inside the lock callback would permanently poison
      // subnode.lock — all future dispatches for this user would chain onto a
      // rejected promise and hang forever. Reset the lock to a resolved state
      // and surface the error to the caller.
      // The raw exception is logged for operators; only a generic message
      // crosses the trust boundary to the RPC caller (see SECURITY-2).
      log.error({ err: e, username: subnode.username }, "Unexpected error in dispatch lock");
      subnode.lock = Promise.resolve();
      resultResolve({ kind: "worker_error", message: "Internal dispatch error. Please retry." });
    });

    return result;
  }

  private async spawnWorker(
    subnode: Subnode,
    identity: ResolvedIdentity,
    tier: "warm" | "burst"
  ): Promise<{ ok: true; worker: Worker } | ({ ok: false } & DispatchError)> {
    const { username, uid, gid } = identity;

    log.info({ username, uid, tier }, "Spawning subnode worker");

    let child: ChildProcess;
    try {
      child = fork(workerPath, [], {
        env: buildWorkerEnv(identity),
        // Do NOT pass uid/gid fork options — the worker drops privileges itself
        // after calling initgroups(), which requires capabilities still set on spawn.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (err) {
      // Raw fork() errors can include OS-level detail (errno text, resource
      // limits, file paths) — log it for operators, return only a generic
      // message to the caller (see SECURITY-2).
      log.error({ err, username }, "Failed to fork subnode worker");
      return { ok: false, kind: "spawn_failed", message: "Failed to spawn a worker process for this request." };
    }

    const worker: Worker = {
      child,
      ready: false,
      readyWaiters: [],
      pending: new Map(),
      idleTimer: null,
      tier,
      uid,
      gid,
    };

    this.wireChildHandlers(subnode, worker);

    const initMsg: SubnodeInit = {
      type: "init",
      shares: this.shareRegistry,
      max_file_size_kb: this.cfg.max_file_size_kb,
    };
    child.send(initMsg);

    const readyResult = await this.waitForReady(worker);
    if (readyResult !== null) return { ok: false, ...readyResult };

    return { ok: true, worker };
  }

  private waitForReady(worker: Worker): Promise<null | DispatchError> {
    const timeoutMs = this.cfg.subnode_rpc_timeout_seconds * 1000;

    return new Promise<null | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        worker.readyWaiters = worker.readyWaiters.filter((w) => w.resolve !== innerResolve);
        this.terminateChild(worker.child, "did not signal ready in time");
        resolve({ kind: "spawn_failed", message: `Subnode worker did not signal ready within ${timeoutMs}ms` });
      }, timeoutMs);

      function innerResolve(): void {
        clearTimeout(timer);
        resolve(null);
      }

      worker.readyWaiters.push({
        resolve: innerResolve,
        reject: (e) => {
          clearTimeout(timer);
          resolve({ kind: "spawn_failed", message: e.message });
        },
      });
    });
  }

  private sendRequest(
    subnode: Subnode,
    worker: Worker,
    tool: string,
    share: string,
    params: unknown,
    requestId: string
  ): Promise<DispatchResult | DispatchError> {
    const timeoutMs = this.cfg.subnode_rpc_timeout_seconds * 1000;

    const msg: SubnodeRequest = { type: "request", request_id: requestId, tool, share, params };

    return new Promise<DispatchResult | DispatchError>((resolve) => {
      const timer = setTimeout(() => {
        worker.pending.delete(requestId);
        this.removeWorker(subnode, worker, "RPC timeout");
        resolve({ kind: "timeout", message: `Request did not complete within ${timeoutMs}ms` });
      }, timeoutMs);

      worker.pending.set(requestId, {
        resolve: (resp) => {
          clearTimeout(timer);
          this.onRequestComplete(subnode, worker);
          resolve({ result: resp.result, error: resp.error });
        },
        reject: (e) => {
          clearTimeout(timer);
          resolve({ kind: "worker_error", message: e.message });
        },
      });

      if (!worker.child.send(msg)) {
        clearTimeout(timer);
        worker.pending.delete(requestId);
        resolve({ kind: "worker_error", message: "Failed to send the request to a worker process." });
      }
    });
  }

  /**
   * Called when a worker finishes a request. Drains the subnode queue first
   * (skipping expired entries), then resets the idle timer if nothing is waiting.
   */
  private onRequestComplete(subnode: Subnode, worker: Worker): void {
    while (subnode.queue.length > 0) {
      const entry = subnode.queue.shift()!;
      if (Date.now() > entry.deadline) {
        entry.resolve({ kind: "timeout", message: "Request timed out waiting for a free worker" });
        continue;
      }
      void this.sendRequest(subnode, worker, entry.tool, entry.share, entry.params, entry.requestId)
        .then(entry.resolve);
      return;
    }
    this.resetIdleTimer(subnode, worker);
  }

  private resetIdleTimer(subnode: Subnode, worker: Worker): void {
    this.clearIdleTimer(worker);
    if (worker.pending.size > 0) return;
    const idleSec = worker.tier === "warm"
      ? this.cfg.subnode_workers.warm_idle_seconds
      : this.cfg.subnode_workers.burst_idle_seconds;
    worker.idleTimer = setTimeout(() => {
      log.info({ username: subnode.username, tier: worker.tier }, "Worker idle timeout — removing");
      this.removeWorker(subnode, worker, "idle timeout");
    }, idleSec * 1000);
  }

  private clearIdleTimer(worker: Worker): void {
    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }
  }

  private wireChildHandlers(subnode: Subnode, worker: Worker): void {
    const { child } = worker;
    const { username } = subnode;

    child.on("message", (rawMsg: unknown) => {
      const msg = rawMsg as SubnodeReady | SubnodeResponse;

      if (msg.type === "ready") {
        worker.ready = true;
        for (const w of worker.readyWaiters) w.resolve();
        worker.readyWaiters = [];
        // Don't set idle timer here — the request this worker was spawned for
        // hasn't been sent yet (sendRequest runs after spawnWorker resolves).
        // resetIdleTimer runs once that request completes.
        return;
      }

      if (msg.type === "response") {
        const waiter = worker.pending.get(msg.request_id);
        if (!waiter) {
          log.error({ username, request_id: msg.request_id }, "Received response for unknown request_id — removing worker");
          this.removeWorker(subnode, worker, "unknown request_id");
          return;
        }
        worker.pending.delete(msg.request_id);
        waiter.resolve(msg);
        return;
      }

      log.error({ username, msg }, "Received unknown message from subnode — removing worker");
      this.removeWorker(subnode, worker, "unknown message type");
    });

    child.on("exit", (code, signal) => {
      log.info({ username, code, signal }, "Subnode worker exited");
      this.removeWorker(subnode, worker, `exited with code=${code} signal=${signal}`);
    });

    child.on("error", (err) => {
      log.error({ err, username }, "Subnode worker process error");
      this.removeWorker(subnode, worker, (err as Error).message);
    });
  }

  /**
   * Removes a worker from its subnode, kills the process, and rejects any
   * in-flight requests. Closures capture worker/subnode directly, so an async
   * exit event for an already-removed worker is a harmless no-op (indexOf
   * returns -1, splice does nothing).
   *
   * If the last worker is removed and the queue is non-empty, those requests
   * are rejected — the next dispatch from this user will spawn a fresh subnode.
   */
  private removeWorker(subnode: Subnode, worker: Worker, reason: string): void {
    const idx = subnode.workers.indexOf(worker);
    if (idx !== -1) subnode.workers.splice(idx, 1);
    this.clearIdleTimer(worker);

    // `reason` (exit codes, signals, child_process error text) is internal
    // detail for operators only — log it in full here, but never echo it
    // into an error that crosses the trust boundary to the RPC caller
    // below (see SECURITY-2).
    log.info({ username: subnode.username, reason, tier: worker.tier }, "Removing subnode worker");
    this.terminateChild(worker.child, reason);

    const err = new Error("Subnode worker terminated unexpectedly");
    for (const w of worker.readyWaiters) w.reject(err);
    for (const w of worker.pending.values()) w.reject(err);

    if (subnode.workers.length === 0) {
      // Reject any stranded queued requests — the next dispatch will spawn fresh.
      if (subnode.queue.length > 0) {
        for (const qr of subnode.queue) {
          qr.resolve({ kind: "worker_error", message: "All workers terminated before this request could be processed" });
        }
        subnode.queue = [];
      }
      // Remove subnode from the map only if it's still the current one —
      // a dispatch that ran concurrently may have already replaced it.
      if (this.subnodes.get(subnode.username) === subnode) {
        this.subnodes.delete(subnode.username);
      }
    }
  }

  /**
   * Sends SIGTERM, then escalates to SIGKILL if the process hasn't exited
   * within FORCE_KILL_GRACE_MS. The worker is expected to exit on its own
   * well within that window (see SHUTDOWN_GRACE_MS in subnode-worker.ts) —
   * this is the backstop for a worker that never gets the chance to (killed
   * before its handler installs) or is too wedged to honor its own timers.
   */
  private terminateChild(child: ChildProcess, reason: string): void {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn({ reason }, "Worker did not exit after SIGTERM — sending SIGKILL");
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
    }, FORCE_KILL_GRACE_MS);
  }

  /**
   * Tears down every already-warm worker for a user whose UID/GID was just
   * rejected by policy. Without this, a worker spawned before the restriction
   * took effect would keep serving that user's requests (including any
   * in-flight one, via removeWorker's pending-rejection) until it idled out —
   * dispatch()'s checks otherwise only gate *new* spawns, not already-running ones.
   */
  private evictSubnodeWorkers(username: string, reason: string): void {
    const subnode = this.subnodes.get(username);
    if (!subnode) return;
    for (const worker of [...subnode.workers]) {
      this.removeWorker(subnode, worker, reason);
    }
  }

  /**
   * Graceful shutdown: reject new RPCs, drain in-flight requests (up to
   * drainTimeoutMs), then terminate all workers.
   */
  async shutdown(drainTimeoutMs = 30_000): Promise<void> {
    this.shuttingDown = true;

    // Reject all queued requests immediately.
    for (const subnode of this.subnodes.values()) {
      for (const qr of subnode.queue) {
        qr.resolve({ kind: "worker_error", message: "HUB_SHUTTING_DOWN — retry after 45 seconds" });
      }
      subnode.queue = [];
    }

    // Immediately terminate idle workers.
    // Snapshot first — removeWorker mutates subnode.workers during iteration.
    for (const subnode of [...this.subnodes.values()]) {
      for (const worker of [...subnode.workers]) {
        if (worker.pending.size === 0) {
          this.removeWorker(subnode, worker, "shutdown");
        }
      }
    }

    if (this.subnodes.size === 0) return;

    // For workers with in-flight RPCs, wait for their pending requests to settle.
    const drainPromise = new Promise<void>((resolve) => {
      const check = (): void => {
        const allDone = [...this.subnodes.values()].every((s) =>
          s.workers.every((w) => w.pending.size === 0)
        );
        if (allDone) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    await Promise.race([
      drainPromise,
      new Promise<void>((r) => setTimeout(r, drainTimeoutMs)),
    ]);

    // Force-kill whatever remains.
    for (const subnode of [...this.subnodes.values()]) {
      for (const worker of [...subnode.workers]) {
        this.removeWorker(subnode, worker, "drain timeout");
      }
    }
  }
}
