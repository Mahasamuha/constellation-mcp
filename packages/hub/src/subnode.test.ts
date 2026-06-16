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
  private requests = new Map<string, () => void>();

  send(msg: unknown): boolean {
    const m = msg as Record<string, unknown>;
    if (m["type"] === "init") {
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
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => {
      // removeWorker runs synchronously inside this emit, so by the time it
      // returns, the worker has been removed from subnode.workers/subnodes.
      this.emit("exit", null, signal ?? "SIGTERM");
      this.exited = true;
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

const { SubnodePool, isDispatchError } = await import("./subnode.js");
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

function configWith(subnode_uid: SubnodeUidConfig, workers?: Partial<SubnodeWorkersConfig>): HubConfig {
  return {
    relay_url: "https://relay.example.com",
    hub_name: "test-hub",
    subnode_workers: workersConfig(workers),
    subnode_rpc_timeout_seconds: 30,
    subnode_uid,
    subnode_gid: {},
    labels: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
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
});
