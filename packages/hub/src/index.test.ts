import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as ServerSideSocket } from "ws";
import type { IncomingMessage } from "node:http";

// resolveIdentity always shells out to `getent passwd` for a real OS user — mocked here
// so the dispatch-error audit tests below don't depend on a specific OS user existing on
// whatever machine runs this suite. None of the other tests in this file ever reach
// handleRpc (rotateToken's messages are handled before that branch), so this has no
// effect on them.
vi.mock("./identity.js", () => ({
  resolveIdentity: vi.fn(),
  isIdentityError: (v: unknown): boolean => typeof v === "object" && v !== null && "kind" in v,
}));

import { resolveDstShare, HubSocket } from "./index.js";
import { SubnodePool, type DispatchError } from "./subnode.js";
import { resolveIdentity } from "./identity.js";
import type { HubConfig } from "./config.js";
import type { RpcEnvelope } from "@constellation/shared";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

function envelope(params: Record<string, unknown> = {}, tool = "copy"): RpcEnvelope {
  return {
    request_id: "req-1",
    tool,
    share: "docs",
    absolute_root: "/srv/docs",
    params,
  };
}

const registry = { docs: "/srv/docs", other: "/srv/other" };

describe("resolveDstShare", () => {
  it("returns null for non copy/move tools, even if dst_share is present", () => {
    expect(resolveDstShare(envelope({ dst_share: "other" }, "read_file"), "read_file", registry)).toBeNull();
  });

  it("returns null when neither dst_share nor dst_root is present", () => {
    expect(resolveDstShare(envelope(), "copy", registry)).toBeNull();
  });

  it("prefers the client-supplied dst_share", () => {
    expect(resolveDstShare(envelope({ dst_share: "other", dst_root: "/srv/docs" }), "copy", registry)).toBe("other");
  });

  it("reverse-resolves dst_root to a share name when dst_share is absent", () => {
    expect(resolveDstShare(envelope({ dst_root: "/srv/other" }), "move", registry)).toBe("other");
  });

  it("returns null when dst_root doesn't match any registered share", () => {
    expect(resolveDstShare(envelope({ dst_root: "/srv/unregistered" }), "copy", registry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HubSocket.rotateToken — mirrors connection.test.ts's NodeConnection.rotateToken
// coverage. Hub's version additionally persists to env_file instead of node.yaml,
// and refuses to start a rotation at all when no env_file is configured.
// ---------------------------------------------------------------------------

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await flush();
  }
}

function nextConnection(server: WebSocketServer): Promise<[ServerSideSocket, IncomingMessage]> {
  return new Promise((resolve) => server.once("connection", (ws, req) => resolve([ws, req])));
}

function waitForMessage(ws: ServerSideSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

function minimalHubConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    relay_url: "http://unused.example.com",
    hub_name: "test-hub",
    subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.5 },
    max_concurrent_subnodes: 0,
    subnode_rpc_timeout_seconds: 30,
    subnode_uid: {},
    subnode_gid: {},
    shares: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
    ...overrides,
  };
}

describe("HubSocket.rotateToken", () => {
  let dir: string;
  let wss: WebSocketServer;
  let port: number;
  let socket: HubSocket | undefined;

  beforeEach(async () => {
    dir = await makeTempDir();
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    socket?.stop();
    socket = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await cleanTempDir(dir);
  });

  function envFilePath(): string {
    return join(dir, "hub.env");
  }

  function startHub(token: string, withEnvFile: boolean): HubSocket {
    const cfg = minimalHubConfig({
      relay_url: `http://localhost:${port}`,
      env_file: withEnvFile ? envFilePath() : undefined,
    });
    socket = new HubSocket(cfg, token, {}, new SubnodePool(cfg, {}));
    socket.start();
    return socket;
  }

  it("resolves only once the reconnect with the new token actually succeeds, and persists it to env_file", async () => {
    const s = startHub("tok-original", true);

    const [firstConn, firstReq] = await nextConnection(wss);
    expect(firstReq.headers.authorization).toBe("Bearer tok-original");
    await waitForMessage(firstConn); // the initial hub_share_sync sent from onOpen()

    const rotatePromise = s.rotateToken();
    let resolved = false;
    void rotatePromise.then(() => { resolved = true; }).catch(() => { /* observed below */ });

    const rotateMsg = await waitForMessage(firstConn);
    expect(rotateMsg).toEqual({ type: "rotate_token" });

    const secondConnPromise = nextConnection(wss);
    firstConn.send(JSON.stringify({ type: "token_rotated", token: "tok-rotated" }));

    // Must not resolve just because the relay replied — only once the resulting
    // reconnect (closing firstConn, opening a new one) actually succeeds.
    await flush();
    expect(resolved).toBe(false);

    const [, secondReq] = await secondConnPromise;
    expect(secondReq.headers.authorization).toBe("Bearer tok-rotated");

    await pollUntil(() => resolved);
    expect(readFileSync(envFilePath(), "utf8")).toContain("CONSTELLATION_HUB_TOKEN=tok-rotated");
  });

  it("rejects when the relay reports rotate_token_error, leaving env_file untouched", async () => {
    const s = startHub("tok-original", true);

    const [firstConn] = await nextConnection(wss);
    await waitForMessage(firstConn);
    const rotatePromise = s.rotateToken();
    await waitForMessage(firstConn);
    firstConn.send(JSON.stringify({ type: "rotate_token_error", error: "Internal error" }));

    await expect(rotatePromise).rejects.toThrow("Internal error");
    expect(existsSync(envFilePath())).toBe(false);
  });

  it("rejects a second rotation request while one is already in progress", async () => {
    const s = startHub("tok-original", true);
    await nextConnection(wss);

    const first = s.rotateToken();
    await expect(s.rotateToken()).rejects.toThrow("already in progress");

    first.catch(() => { /* expected — connection torn down in afterEach before relay replies */ });
  });

  it("rejects immediately, without contacting the relay, when no env_file is configured", async () => {
    const s = startHub("tok-original", false);
    const [firstConn] = await nextConnection(wss);

    await expect(s.rotateToken()).rejects.toThrow("No env_file configured");

    // No rotate_token message should ever have been sent — verified by racing a
    // flush against a message wait that must not resolve.
    let gotMessage = false;
    void waitForMessage(firstConn).then(() => { gotMessage = true; });
    await flush();
    expect(gotMessage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HubSocket — malformed RPC params. onMessage casts the raw WS message to
// IncomingRpcEnvelope after checking only that request_id/tool are strings; without a
// guard, a non-object params throws inside resolveDstShare, which skips every
// writeAuditEntry call in handleRpc (onMessage's catch-all replies with a clean error
// but knows nothing about the audit log's shape).
// ---------------------------------------------------------------------------

describe("HubSocket — malformed RPC params", () => {
  let dir: string;
  let wss: WebSocketServer;
  let port: number;
  let socket: HubSocket | undefined;

  beforeEach(async () => {
    dir = await makeTempDir();
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    socket?.stop();
    socket = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await cleanTempDir(dir);
  });

  it("rejects with a clean error and still writes an audit entry, instead of throwing inside resolveDstShare", async () => {
    const auditLog = join(dir, "audit.jsonl");
    const cfg = minimalHubConfig({ relay_url: `http://localhost:${port}`, audit_log: auditLog });
    socket = new HubSocket(cfg, "tok", {}, new SubnodePool(cfg, {}));
    socket.start();

    const [conn] = await nextConnection(wss);
    await waitForMessage(conn); // the initial hub_share_sync sent from onOpen()

    conn.send(JSON.stringify({ request_id: "req-1", tool: "copy", params: null }));
    const response = await waitForMessage(conn);

    expect(response).toEqual({ request_id: "req-1", error: { message: "Malformed request: params must be an object" } });

    const logged = readFileSync(auditLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      request_id: "req-1",
      tool: "copy",
      outcome: "exec_error",
      error: "Malformed request: params must be an object",
    });
  });
});

// ---------------------------------------------------------------------------
// HubSocket — dispatch-error kind reaches the audit log. Each DispatchError kind
// (uid_blocked, gid_blocked, spawn_failed, timeout, worker_error, subnode_limit) used to
// collapse into the same generic "exec_error" outcome — an operator couldn't filter
// "policy rejection" from "capacity" from "infra failure" without string-matching the
// free-text message. The audit entry's outcome should now be the specific kind itself.
// ---------------------------------------------------------------------------

describe("HubSocket — dispatch-error kind in the audit log", () => {
  let dir: string;
  let wss: WebSocketServer;
  let port: number;
  let socket: HubSocket | undefined;

  beforeEach(async () => {
    dir = await makeTempDir();
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
    vi.mocked(resolveIdentity).mockResolvedValue({ username: "alice", uid: 1000, gid: 1000, home: "/home/alice" });
  });

  afterEach(async () => {
    socket?.stop();
    socket = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await cleanTempDir(dir);
    vi.clearAllMocks();
  });

  const kinds: DispatchError["kind"][] = [
    "uid_blocked", "gid_blocked", "spawn_failed", "timeout", "worker_error", "subnode_limit",
  ];

  it.each(kinds)("uses %s as the audit outcome instead of the generic exec_error", async (kind) => {
    const auditLog = join(dir, "audit.jsonl");
    const cfg = minimalHubConfig({
      relay_url: `http://localhost:${port}`,
      audit_log: auditLog,
      shares: [{ name: "docs", path: "/srv/docs", permissions: { default: "read-write", overrides: [] } }],
    });
    const pool = new SubnodePool(cfg, {});
    vi.spyOn(pool, "dispatch").mockResolvedValue({ kind, message: `synthetic ${kind} failure` });
    socket = new HubSocket(cfg, "tok", {}, pool);
    socket.start();

    const [conn] = await nextConnection(wss);
    await waitForMessage(conn); // the initial hub_share_sync sent from onOpen()

    conn.send(JSON.stringify({ request_id: "req-1", tool: "read_file", share: "docs", absolute_root: "/srv/docs", params: {} }));
    const response = await waitForMessage(conn);

    expect(response).toEqual({ request_id: "req-1", error: { message: `synthetic ${kind} failure` } });

    const logged = readFileSync(auditLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      request_id: "req-1",
      outcome: kind,
      error: `synthetic ${kind} failure`,
    });
  });
});
