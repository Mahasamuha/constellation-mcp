import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:os", () => ({ userInfo: () => ({ uid: 2000, gid: 2000 }) }));
vi.mock("./identity.js", () => ({ getGroupIds: vi.fn(async () => [1000]) }));

// ---------------------------------------------------------------------------
// Fake subnode worker — simulates the SubnodeReady/SubnodeResponse protocol
// over a fake ChildProcess so SubnodePool.dispatch can be exercised without
// forking a real process.
//
// init → ready is auto-resolved (microtask) so spawning completes normally.
// request → response is controller-driven: call child.respond(requestId) to
// trigger the response. This lets tests exercise concurrency (burst spawning,
// queueing) deterministically.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  killed = false;
  /** True once the queued "exit" event has actually fired (removeWorker has run). */
  exited = false;
  /** Mirrors the real ChildProcess fields terminateChild() inspects to decide whether to escalate. */
  exitCode: number | null = null;
  signalCode: string | null = null;
  /**
   * Simulates a worker wedged on something that ignores SIGTERM (e.g. a hung
   * fs call) — SIGTERM is recorded but does not cause an exit. SIGKILL always
   * succeeds, matching real OS signal semantics where SIGKILL can't be caught.
   */
  ignoreSigterm = false;
  /** The most recent "init" message sent to this worker — lets tests assert what
   * SubnodePool actually threads through (e.g. max_file_size_kb from HubConfig). */
  lastInit: Record<string, unknown> | null = null;
  private requests = new Map<string, () => void>();

  send(msg: unknown): boolean {
    const m = msg as Record<string, unknown>;
    if (m["type"] === "init") {
      this.lastInit = m;
      queueMicrotask(() => this.emit("message", { type: "ready" }));
    } else if (m["type"] === "request") {
      const requestId = m["request_id"] as string;
      this.requests.set(requestId, () => {
        this.requests.delete(requestId);
        this.emit("message", { type: "response", request_id: requestId, result: { ok: true } });
      });
    }
    return true;
  }

  respond(requestId: string): void {
    const fn = this.requests.get(requestId);
    if (fn) fn();
  }

  respondAll(): void {
    for (const fn of [...this.requests.values()]) fn();
  }

  hasPending(requestId: string): boolean {
    return this.requests.has(requestId);
  }

  kill(signal?: string): boolean {
    this.killed = true;
    if (this.exited) return true;
    if (signal === "SIGTERM" && this.ignoreSigterm) return true;
    queueMicrotask(() => {
      // removeWorker runs synchronously inside this emit, so by the time it
      // returns, the worker has been removed from subnode.workers/subnodes.
      if (this.exited) return;
      this.exitCode = null;
      this.signalCode = signal ?? "SIGTERM";
      this.exited = true;
      this.emit("exit", this.exitCode, this.signalCode);
    });
    return true;
  }
}

let forkedChildren: FakeChild[] = [];

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = new FakeChild();
    forkedChildren.push(child);
    return child;
  }),
}));

const { SubnodePool, isDispatchError, FORCE_KILL_GRACE_MS } = await import("./subnode.js");
const { checkUidRestrictions } = await import("./subnode.js");
import type { HubConfig, SubnodeUidConfig, SubnodeWorkersConfig } from "./config.js";
import type { ResolvedIdentity } from "./identity.js";

function workersConfig(overrides: Partial<SubnodeWorkersConfig> = {}): SubnodeWorkersConfig {
  return {
    min: 1,
    max: 1,
    warm_idle_seconds: 300,
    burst_idle_seconds: 30,
    queue_timeout: 0.5,
    ...overrides,
  };
}

function configWith(
  subnode_uid: SubnodeUidConfig,
  workers?: Partial<SubnodeWorkersConfig>,
  maxConcurrentSubnodes = 0
): HubConfig {
  return {
    relay_url: "https://relay.example.com",
    hub_name: "test-hub",
    subnode_workers: workersConfig(workers),
    max_concurrent_subnodes: maxConcurrentSubnodes,
    subnode_rpc_timeout_seconds: 30,
    subnode_uid,
    subnode_gid: {},
    shares: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
    max_file_size_kb: 100,
  };
}

function makeConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return { ...configWith({}), ...overrides };
}

/**
 * Polls `predicate` once per macrotask until it returns true. Used instead of
 * a fixed tick count so tests wait for actual completion (a request registered
 * as pending, a worker removed) rather than guessing how many microtask hops
 * the implementation needs — which breaks silently if that depth ever changes.
 */
async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!predicate()) {
    throw new Error(`waitUntil: condition not met after ${maxTicks} ticks`);
  }
}

const identity: ResolvedIdentity = { username: "alice", uid: 1000, gid: 1000, home: "/home/alice" };

describe("checkUidRestrictions", () => {
  it("always blocks UID 0 (root), regardless of config", () => {
    expect(checkUidRestrictions(0, configWith({ allowed_range: { min: 0, max: 65535 } })))
      .toMatch(/UID 0 \(root\) is always blocked/);
  });

  it("always blocks the hub's own UID", () => {
    // userInfo() is mocked to uid 2000 above
    expect(checkUidRestrictions(2000, configWith({})))
      .toMatch(/matches the hub process UID/);
  });

  it("allows an ordinary UID with no restrictions configured", () => {
    expect(checkUidRestrictions(1001, configWith({}))).toBeNull();
  });

  it("blocks UIDs in the explicit blocklist", () => {
    expect(checkUidRestrictions(1050, configWith({ blocked_uids: [1050] })))
      .toMatch(/UID 1050 is explicitly blocked/);
    expect(checkUidRestrictions(1051, configWith({ blocked_uids: [1050] }))).toBeNull();
  });

  it("blocks UIDs within a blocked range", () => {
    const cfg = configWith({ blocked_range: { min: 1, max: 999 } });
    expect(checkUidRestrictions(500, cfg)).toMatch(/falls within blocked range \[1, 999\]/);
    expect(checkUidRestrictions(1000, cfg)).toBeNull();
  });

  it("rejects UIDs outside an allowed range", () => {
    const cfg = configWith({ allowed_range: { min: 1000, max: 60000 } });
    expect(checkUidRestrictions(999, cfg)).toMatch(/UID 999 is outside allowed range \[1000, 60000\]/);
    expect(checkUidRestrictions(60001, cfg)).toMatch(/UID 60001 is outside allowed range \[1000, 60000\]/);
    expect(checkUidRestrictions(1000, cfg)).toBeNull();
    expect(checkUidRestrictions(60000, cfg)).toBeNull();
  });

  it("evaluates blocklist/blocked-range before allowed-range", () => {
    const cfg = configWith({ allowed_range: { min: 1000, max: 60000 }, blocked_uids: [1500] });
    expect(checkUidRestrictions(1500, cfg)).toMatch(/UID 1500 is explicitly blocked/);
  });

  it("treats an open-ended range bound as unbounded", () => {
    expect(checkUidRestrictions(99999, configWith({ allowed_range: { min: 1000 } }))).toBeNull();
    expect(checkUidRestrictions(1, configWith({ allowed_range: { max: 60000 } }))).toBeNull();
  });
});

describe("SubnodePool.dispatch", () => {
  beforeEach(() => {
    forkedChildren = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a request and returns the result", async () => {
    const pool = new SubnodePool(makeConfig(), {});

    const dispatchPromise = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");

    const result = await dispatchPromise;
    expect(isDispatchError(result)).toBe(false);
    expect(result).toEqual({ result: { ok: true }, error: undefined });

    await pool.shutdown(0);
  });

  it("sends the configured max_file_size_kb to the spawned worker, not a hardcoded default", async () => {
    const pool = new SubnodePool(makeConfig({ max_file_size_kb: 250 }), {});

    const dispatchPromise = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);

    expect(forkedChildren[0]!.lastInit).toMatchObject({ max_file_size_kb: 250 });

    forkedChildren[0]!.respond("req-1");
    await dispatchPromise;
    await pool.shutdown(0);
  });

  it("reuses the pooled worker for a second dispatch from the same user", async () => {
    const pool = new SubnodePool(makeConfig(), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");
    await d1;

    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");
    await waitUntil(() => forkedChildren[0]!.hasPending("req-2"));
    forkedChildren[0]!.respond("req-2");
    await d2;

    expect(forkedChildren.length).toBe(1);

    await pool.shutdown(0);
  });

  it("does not set an idle timer until after the first request completes", async () => {
    const pool = new SubnodePool(makeConfig(), {});

    const d = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);

    const child = forkedChildren[0]!;
    // Worker is spawned and ready but request is still in-flight.
    // Idle timer must not have fired yet.
    expect(child.killed).toBe(false);

    child.respond("req-1");
    await d;
    await pool.shutdown(0);
  });

  it("spawns a burst worker when all warm workers are busy (max > min)", async () => {
    const pool = new SubnodePool(makeConfig({ subnode_workers: workersConfig({ min: 1, max: 2 }) }), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");

    // Wait for both spawns and request sends to settle.
    await waitUntil(() =>
      forkedChildren.length === 2 &&
      forkedChildren[0]!.hasPending("req-1") &&
      forkedChildren[1]!.hasPending("req-2")
    );

    expect(forkedChildren.length).toBe(2);

    forkedChildren[0]!.respond("req-1");
    forkedChildren[1]!.respond("req-2");
    const [r1, r2] = await Promise.all([d1, d2]);

    expect(isDispatchError(r1)).toBe(false);
    expect(isDispatchError(r2)).toBe(false);

    await pool.shutdown(0);
  });

  it("queues requests beyond max and drains them in order as workers free up", async () => {
    const pool = new SubnodePool(makeConfig({ subnode_workers: workersConfig({ min: 1, max: 1 }) }), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");
    const d3 = pool.dispatch(identity, "list_directory", "docs", {}, "req-3");

    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);

    // Only one worker spawned — req-2 and req-3 are queued.
    expect(forkedChildren.length).toBe(1);

    // Complete req-1 → req-2 should immediately be dispatched to the same worker.
    forkedChildren[0]!.respond("req-1");
    await waitUntil(() => forkedChildren[0]!.hasPending("req-2"));
    forkedChildren[0]!.respond("req-2");
    await waitUntil(() => forkedChildren[0]!.hasPending("req-3"));
    forkedChildren[0]!.respond("req-3");

    const [r1, r2, r3] = await Promise.all([d1, d2, d3]);
    expect(isDispatchError(r1)).toBe(false);
    expect(isDispatchError(r2)).toBe(false);
    expect(isDispatchError(r3)).toBe(false);

    await pool.shutdown(0);
  });

  it("rejects a queued request that exceeds the queue timeout deadline", async () => {
    // queue_timeout: 0.5 of rpc_timeout (30s) = 15 000 ms by default.
    // Freeze time so the deadline appears already expired when the queue is drained.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000_000); // used at enqueue (deadline = 1_000_000 + 15_000)
    now.mockReturnValue(1_000_000 + 20_000); // every later check — past the deadline

    const pool = new SubnodePool(makeConfig({ subnode_workers: workersConfig({ min: 1, max: 1 }) }), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");

    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");

    const [r1, r2] = await Promise.all([d1, d2]);
    expect(isDispatchError(r1)).toBe(false);
    expect(isDispatchError(r2)).toBe(true);
    expect((r2 as { kind: string }).kind).toBe("timeout");
  });

  it("warm worker gets warm_idle_seconds timer; burst worker gets burst_idle_seconds timer", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const pool = new SubnodePool(
      makeConfig({ subnode_workers: workersConfig({ min: 1, max: 2, warm_idle_seconds: 300, burst_idle_seconds: 30 }) }),
      {}
    );

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");
    await waitUntil(() =>
      forkedChildren.length === 2 &&
      forkedChildren[0]!.hasPending("req-1") &&
      forkedChildren[1]!.hasPending("req-2")
    );

    forkedChildren[0]!.respond("req-1");
    forkedChildren[1]!.respond("req-2");
    await Promise.all([d1, d2]);

    // After both requests complete the pool sets idle timers.
    // Check that setTimeout was called with 300 000 ms for the warm worker
    // and 30 000 ms for the burst worker.
    const timerCalls = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(timerCalls).toContain(300_000);
    expect(timerCalls).toContain(30_000);

    await pool.shutdown(0);
  });

  it("removes the subnode map entry once all workers are gone; next dispatch spawns fresh", async () => {
    const pool = new SubnodePool(makeConfig(), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");
    await d1;

    // Force-kill the worker to trigger removal. removeWorker runs synchronously
    // inside the "exit" handler, so once `exited` flips, the subnode map entry
    // is already gone.
    forkedChildren[0]!.kill("SIGTERM");
    await waitUntil(() => forkedChildren[0]!.exited);

    // Next dispatch should spawn a new worker (second entry in forkedChildren).
    const d2 = pool.dispatch(identity, "list_directory", "docs", {}, "req-2");
    await waitUntil(() => forkedChildren.length === 2 && forkedChildren[1]!.hasPending("req-2"));
    forkedChildren[1]!.respond("req-2");

    const r2 = await d2;
    expect(isDispatchError(r2)).toBe(false);
    expect(forkedChildren.length).toBe(2);

    await pool.shutdown(0);
  });

  it("evicts a stale worker and spawns fresh when the same username resolves to a different uid", async () => {
    const pool = new SubnodePool(makeConfig(), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");
    await d1;

    // Same username, but the OS now resolves it to a different uid (e.g. the
    // account was deleted and recreated with a recycled uid). The pool must
    // not hand this request to the already-warm worker still running under
    // the old uid.
    const remappedIdentity: ResolvedIdentity = { ...identity, uid: identity.uid + 1 };
    const d2 = pool.dispatch(remappedIdentity, "list_directory", "docs", {}, "req-2");

    await waitUntil(() => forkedChildren[0]!.exited);
    await waitUntil(() => forkedChildren.length === 2 && forkedChildren[1]!.hasPending("req-2"));
    forkedChildren[1]!.respond("req-2");

    const r2 = await d2;
    expect(isDispatchError(r2)).toBe(false);
    expect(forkedChildren.length).toBe(2);
    expect(forkedChildren[0]!.killed).toBe(true);

    await pool.shutdown(0);
  });

  it("evicts already-warm workers immediately when a uid is newly blocked by policy", async () => {
    const subnodeUid: SubnodeUidConfig = {};
    const pool = new SubnodePool(makeConfig({ subnode_uid: subnodeUid }), {});

    const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
    await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
    forkedChildren[0]!.respond("req-1");
    await d1;

    // Operator blocks this uid after the worker is already warm.
    subnodeUid.blocked_uids = [identity.uid];

    const r2 = await pool.dispatch(identity, "list_directory", "docs", {}, "req-2");
    expect(isDispatchError(r2)).toBe(true);
    expect((r2 as { kind: string }).kind).toBe("uid_blocked");

    // The already-warm worker from before the block must be torn down rather
    // than left running indefinitely under now-revoked access.
    await waitUntil(() => forkedChildren[0]!.exited);

    await pool.shutdown(0);
  });

  it("escalates to SIGKILL when a worker ignores SIGTERM past the force-kill grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pool = new SubnodePool(makeConfig({ subnode_rpc_timeout_seconds: 5 }), {});

      const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
      await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);

      // This worker never responds and won't honor SIGTERM — simulates a
      // worker wedged on a hung fs call (e.g. a stalled network mount).
      const child = forkedChildren[0]!;
      child.ignoreSigterm = true;

      // RPC timeout fires — pool sends SIGTERM, which this worker ignores.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.killed).toBe(true);
      expect(child.exited).toBe(false);

      // Past the force-kill grace period, the pool escalates to SIGKILL.
      await vi.advanceTimersByTimeAsync(FORCE_KILL_GRACE_MS);
      await waitUntil(() => child.exited);
      expect(child.signalCode).toBe("SIGKILL");

      const r1 = await d1;
      expect(isDispatchError(r1)).toBe(true);
      expect((r1 as { kind: string }).kind).toBe("timeout");

      await pool.shutdown(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("max_concurrent_subnodes", () => {
    const bob: ResolvedIdentity = { username: "bob", uid: 1001, gid: 1000, home: "/home/bob" };
    const carol: ResolvedIdentity = { username: "carol", uid: 1002, gid: 1000, home: "/home/carol" };

    it("rejects a new identity once the global cap is reached, without disturbing identities already tracked", async () => {
      const pool = new SubnodePool(configWith({}, undefined, 1), {});

      const d1 = pool.dispatch(identity, "list_directory", "docs", {}, "req-1");
      await waitUntil(() => forkedChildren[0]?.hasPending("req-1") ?? false);
      forkedChildren[0]!.respond("req-1");
      expect(isDispatchError(await d1)).toBe(false);

      // alice's subnode now occupies the one slot the cap allows — bob, a new
      // identity, must be rejected rather than spawning a second one.
      const bobResult = await pool.dispatch(bob, "list_directory", "docs", {}, "req-2");
      expect(isDispatchError(bobResult)).toBe(true);
      expect((bobResult as { kind: string }).kind).toBe("subnode_limit");
      expect(forkedChildren.length).toBe(1);

      // alice is already tracked, so the cap must not block her further requests.
      const d3 = pool.dispatch(identity, "list_directory", "docs", {}, "req-3");
      await waitUntil(() => forkedChildren[0]!.hasPending("req-3"));
      forkedChildren[0]!.respond("req-3");
      expect(isDispatchError(await d3)).toBe(false);

      await pool.shutdown(0);
    });

    it("treats 0 (the default) as unlimited", async () => {
      const pool = new SubnodePool(configWith({}, undefined, 0), {});

      for (const [id, reqId] of [[identity, "req-1"], [bob, "req-2"], [carol, "req-3"]] as const) {
        const d = pool.dispatch(id, "list_directory", "docs", {}, reqId);
        await waitUntil(() => forkedChildren.at(-1)?.hasPending(reqId) ?? false);
        forkedChildren.at(-1)!.respond(reqId);
        expect(isDispatchError(await d)).toBe(false);
      }
      expect(forkedChildren.length).toBe(3);

      await pool.shutdown(0);
    });
  });
});
