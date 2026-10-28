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
    path_filters: [],
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

  it("returns the normalized path (not null) when dst_root doesn't match any registered share", () => {
    // Fail-closed: an unrecognised dst_root returns the path itself so checkPermission
    // rejects it as an unknown share, rather than null which would skip the check entirely.
    expect(resolveDstShare(envelope({ dst_root: "/srv/unregistered" }), "copy", registry)).toBe("/srv/unregistered");
  });

  it("returns the normalized path when dst_root is a symlink-style non-canonical path", () => {
    // path.resolve strips trailing slashes; a symlink pointing at a share root still
    // won't match guessShare (no symlink resolution), so we get the normalized path back.
    expect(resolveDstShare(envelope({ dst_root: "/srv/unregistered/" }), "copy", registry)).toBe("/srv/unregistered");
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
    identity: { claims: [], user_map: [] },
    audit_log: "/var/log/constellation/audit.jsonl",
    max_file_size_kb: 100,
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

  const NEW_TOKEN = "ab".repeat(32);

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
    firstConn.send(JSON.stringify({ type: "token_rotated", token: NEW_TOKEN }));

    // Must not resolve just because the relay replied — only once the resulting
    // reconnect (closing firstConn, opening a new one) actually succeeds.
    await flush();
    expect(resolved).toBe(false);

    const [, secondReq] = await secondConnPromise;
    expect(secondReq.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);

    await pollUntil(() => resolved);
    const env = readFileSync(envFilePath(), "utf8");
    expect(env).toContain(`CONSTELLATION_HUB_TOKEN=${NEW_TOKEN}`);
    // Confirmed by the successful reconnect, so the displaced token is cleared.
    expect(env).not.toContain("tok-original");
  });

  it("keeps the previous token in env_file until the new one has connected", async () => {
    const s = startHub("tok-original", true);
    const [firstConn] = await nextConnection(wss);
    await waitForMessage(firstConn);
    const rotatePromise = s.rotateToken();
    rotatePromise.catch(() => { /* torn down in afterEach if it never settles */ });
    await waitForMessage(firstConn);

    // Hold the reconnect: the server only learns of the new connection after we look at the file.
    firstConn.send(JSON.stringify({ type: "token_rotated", token: NEW_TOKEN }));
    await pollUntil(() => existsSync(envFilePath()));
    const during = readFileSync(envFilePath(), "utf8");
    expect(during).toContain("CONSTELLATION_HUB_PREVIOUS_TOKEN=tok-original");
    expect(during).toContain(`CONSTELLATION_HUB_TOKEN=${NEW_TOKEN}`);
  });

  it.each([
    ["too short", "tok-rotated"],
    ["uppercase hex", "AB".repeat(32)],
    ["contains a newline", `${"ab".repeat(31)}\nX=1`],
    ["not a string", 7],
  ])("refuses a rotated token that is %s, leaving env_file untouched and the old token in use", async (_n, bad) => {
    const s = startHub("tok-original", true);
    const [firstConn] = await nextConnection(wss);
    await waitForMessage(firstConn);
    const rotatePromise = s.rotateToken();
    await waitForMessage(firstConn);
    firstConn.send(JSON.stringify({ type: "token_rotated", token: bad }));
    await expect(rotatePromise).rejects.toThrow();
    expect(existsSync(envFilePath())).toBe(false);
  });

  it("ignores token_rotated when no rotation is pending", async () => {
    startHub("tok-original", true);
    const [firstConn] = await nextConnection(wss);
    await waitForMessage(firstConn);
    firstConn.send(JSON.stringify({ type: "token_rotated", token: NEW_TOKEN }));
    await flush(); await flush();
    expect(existsSync(envFilePath())).toBe(false);
    // Still connected: no reconnect was triggered.
    expect(firstConn.readyState).toBe(firstConn.OPEN);
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

    // The audit write is now async/fire-and-forget (see AuditWriter) — it's enqueued
    // before the response is sent, but not necessarily landed on disk yet.
    await pollUntil(() => existsSync(auditLog) && readFileSync(auditLog, "utf8").trim().length > 0);
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

    conn.send(JSON.stringify({ request_id: "req-1", tool: "read_file", share: "docs", absolute_root: "/srv/docs", params: {}, user_sub: "sub-1", user_groups: [], user_claims: {}, path_filters: [] }));
    const response = await waitForMessage(conn);

    expect(response).toEqual({ request_id: "req-1", error: { message: `synthetic ${kind} failure` } });

    // The audit write is now async/fire-and-forget (see AuditWriter) — it's enqueued
    // before the response is sent, but not necessarily landed on disk yet.
    await pollUntil(() => existsSync(auditLog) && readFileSync(auditLog, "utf8").trim().length > 0);
    const logged = readFileSync(auditLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      request_id: "req-1",
      outcome: kind,
      error: `synthetic ${kind} failure`,
    });
  });
});

// ---------------------------------------------------------------------------
// HubSocket — the new user fields on the envelope: user_sub is required with no
// fallback, user_groups drives group overrides, and the sub (not a claim) is what
// identity resolution and the audit log see.
// ---------------------------------------------------------------------------

describe("HubSocket — user_sub / user_groups handling", () => {
  let dir: string;
  let wss: WebSocketServer;
  let port: number;
  let socket: HubSocket | undefined;
  let pool: SubnodePool;
  let auditLog: string;

  beforeEach(async () => {
    dir = await makeTempDir();
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
    vi.mocked(resolveIdentity).mockResolvedValue({ username: "alice", uid: 1000, gid: 1000, home: "/home/alice" });
    auditLog = join(dir, "audit.jsonl");
  });

  afterEach(async () => {
    socket?.stop();
    socket = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await cleanTempDir(dir);
    vi.clearAllMocks();
  });

  async function connect(shares: HubConfig["shares"]) {
    const cfg = minimalHubConfig({ relay_url: `http://localhost:${port}`, audit_log: auditLog, shares });
    pool = new SubnodePool(cfg, {});
    vi.spyOn(pool, "dispatch").mockResolvedValue({ result: { ok: true } } as never);
    socket = new HubSocket(cfg, "tok", {}, pool);
    socket.start();
    const [conn] = await nextConnection(wss);
    await waitForMessage(conn);
    return conn;
  }

  async function call(conn: ServerSideSocket, extra: Record<string, unknown>) {
    conn.send(JSON.stringify({ request_id: "req-1", tool: "read_file", share: "docs", absolute_root: "/srv/docs", params: {}, user_claims: {}, path_filters: [], ...extra }));
    return waitForMessage(conn);
  }

  async function auditLines(): Promise<Record<string, unknown>[]> {
    await pollUntil(() => existsSync(auditLog) && readFileSync(auditLog, "utf8").trim().length > 0);
    return readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  const docs = (overrides: HubConfig["shares"][number]["permissions"]["overrides"] = [], def: "none" | "read-write" = "none") =>
    [{ name: "docs", path: "/srv/docs", permissions: { default: def, overrides } }];

  it.each([
    ["missing", {}],
    ["empty", { user_sub: "" }],
    ["a number", { user_sub: 7 }],
    ["an array", { user_sub: ["a"] }],
  ])("refuses an RPC whose user_sub is %s, with no fallback", async (_label, extra) => {
    const conn = await connect(docs([], "read-write"));
    const response = await call(conn, { user_groups: [], ...extra });
    expect(response).toEqual({ request_id: "req-1", error: { message: "Malformed request: user_sub must be a non-empty string" } });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(pool.dispatch).not.toHaveBeenCalled();
    expect((await auditLines())[0]).toMatchObject({ outcome: "exec_error", user_sub: null });
  });

  it("refuses a legacy envelope that carries only user_oidc_sub", async () => {
    const conn = await connect(docs([], "read-write"));
    const response = await call(conn, { user_oidc_sub: "legacy", user_groups: [] });
    expect(response).toMatchObject({ error: { message: expect.stringContaining("user_sub") } });
    expect(pool.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["a string", { user_groups: "eng" }],
    ["an object", { user_groups: { 0: "eng" } }],
  ])("refuses an RPC whose user_groups is %s", async (_label, extra) => {
    const conn = await connect(docs([], "read-write"));
    const response = await call(conn, { user_sub: "sub-1", ...extra });
    expect(response).toEqual({ request_id: "req-1", error: { message: "Malformed request: user_groups must be an array" } });
    expect(pool.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["an entry that is not a string", ["eng", 7]],
    ["an empty entry", ["eng", ""]],
    ["an over-long entry", ["x".repeat(257)]],
    ["too many entries", Array.from({ length: 257 }, (_, i) => `g${i}`)],
  ])("refuses an RPC whose user_groups has %s, and audits it without the values", async (_label, user_groups) => {
    const conn = await connect(docs([{ group: "banned", access: "none" }], "read-write"));
    const response = await call(conn, { user_sub: "sub-1", user_groups });
    expect(response).toEqual({ request_id: "req-1", error: { message: "Malformed request: user_groups is not a valid group list" } });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(pool.dispatch).not.toHaveBeenCalled();
    const [entry] = await auditLines();
    expect(entry).toMatchObject({ outcome: "exec_error", user_sub: "sub-1" });
    expect(JSON.stringify(entry)).not.toContain("xxxx");
  });

  it.each([
    ["missing", undefined],
    ["a string", "x"],
    ["not all strings", ["a", 1]],
    ["more than 100 entries", Array(101).fill("a")],
  ])("refuses and audits an RPC whose path_filters is %s", async (_label, path_filters) => {
    const conn = await connect(docs([], "read-write"));
    const response = await call(conn, { user_sub: "sub-1", user_groups: [], path_filters });
    expect(response).toMatchObject({ error: { message: expect.stringContaining("path_filters") } });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(pool.dispatch).not.toHaveBeenCalled();
    expect((await auditLines())[0]).toMatchObject({ outcome: "exec_error", user_sub: "sub-1" });
  });

  it("passes the envelope's path_filters to the subnode dispatch", async () => {
    const conn = await connect(docs([], "read-write"));
    await call(conn, { user_sub: "sub-1", user_groups: [], path_filters: ["^/x$"] });
    expect(pool.dispatch).toHaveBeenCalledWith(expect.anything(), "read_file", "docs", {}, "req-1", ["^/x$"]);
  });

  it("passes the sub to identity resolution and records it in the audit log", async () => {
    const conn = await connect(docs([], "read-write"));
    const response = await call(conn, { user_sub: "sub-1", user_groups: ["eng"], user_claims: { constellation_username: "alice" } });
    expect(response).toEqual({ request_id: "req-1", result: { ok: true } });
    expect(resolveIdentity).toHaveBeenCalledWith({ constellation_username: "alice" }, "sub-1", expect.anything());
    const [entry] = await auditLines();
    expect(entry).toMatchObject({ user_sub: "sub-1", local_username: "alice", outcome: "ok" });
    expect(entry).not.toHaveProperty("user_oidc_sub");
  });

  it("grants access through a group override", async () => {
    const conn = await connect(docs([{ group: "eng", access: "read-write" }]));
    const response = await call(conn, { user_sub: "sub-1", user_groups: ["eng"] });
    expect(response).toEqual({ request_id: "req-1", result: { ok: true } });
  });

  it("denies a user whose groups do not match when the default is none", async () => {
    const conn = await connect(docs([{ group: "eng", access: "read-write" }]));
    const response = await call(conn, { user_sub: "sub-1", user_groups: ["sales"] });
    expect(response).toMatchObject({ error: { message: "Access to share 'docs' is denied" } });
    expect(pool.dispatch).not.toHaveBeenCalled();
  });

  it("lets a group override restrict, and a sub override beat it", async () => {
    const restricted = docs([{ group: "contractors", access: "none" }, { sub: "sub-2", access: "read-write" }], "read-write");
    const conn = await connect(restricted);
    expect(await call(conn, { user_sub: "sub-1", user_groups: ["contractors"] })).toMatchObject({ error: { message: "Access to share 'docs' is denied" } });
    expect(await call(conn, { user_sub: "sub-2", user_groups: ["contractors"] })).toEqual({ request_id: "req-1", result: { ok: true } });
  });
});
