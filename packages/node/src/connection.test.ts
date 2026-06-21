import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSideSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { NodeConnection } from "./connection.js";
import { writeNodeConfig, writePathsConfig, loadNodeConfig, loadPathsConfig } from "./config.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

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

/** Resolves with the server-side socket and the upgrade request (for inspecting the
 * Authorization header — the `ws` library doesn't expose that on the socket itself). */
function nextConnection(server: WebSocketServer): Promise<[ServerSideSocket, IncomingMessage]> {
  return new Promise((resolve) => server.once("connection", (ws, req) => resolve([ws, req])));
}

function waitForMessage(ws: ServerSideSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

let dir: string;
let wss: WebSocketServer;
let port: number;
let conn: NodeConnection | undefined;

beforeEach(async () => {
  dir = await makeTempDir();
  writePathsConfig(dir, { paths: [] });
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  port = (wss.address() as { port: number }).port;
});

afterEach(async () => {
  conn?.stop();
  conn = undefined;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await cleanTempDir(dir);
});

function configureNode(token: string): void {
  writeNodeConfig(dir, { relay_url: `http://localhost:${port}`, node_token: token, host: "test-host" });
}

function startConnection(): NodeConnection {
  conn = new NodeConnection({
    configDir: dir,
    getConfig: () => loadNodeConfig(dir),
    getPaths: () => loadPathsConfig(dir).paths,
  });
  conn.start();
  return conn;
}

describe("NodeConnection.rotateToken", () => {
  it("resolves only once the reconnect with the new token actually succeeds", async () => {
    configureNode("tok-original");
    const c = startConnection();

    const [firstConn, firstReq] = await nextConnection(wss);
    expect(firstReq.headers.authorization).toBe("Bearer tok-original");
    await waitForMessage(firstConn); // the initial config_update sent from onOpen()

    const rotatePromise = c.rotateToken();
    let resolved = false;
    // Defensive .catch(): if an assertion below throws before the promise settles, the
    // connection still gets stopped in afterEach, which would reject this with nothing
    // attached to observe it otherwise.
    void rotatePromise.then(() => { resolved = true; }).catch(() => { /* observed below */ });

    const rotateMsg = await waitForMessage(firstConn);
    expect(rotateMsg).toEqual({ type: "rotate_token" });

    const secondConnPromise = nextConnection(wss);
    firstConn.send(JSON.stringify({ type: "token_rotated", token: "tok-rotated" }));

    // The promise must not resolve just because the relay replied — only once the
    // resulting reconnect (closing firstConn, opening a new one) actually succeeds.
    await flush();
    expect(resolved).toBe(false);

    const [, secondReq] = await secondConnPromise;
    expect(secondReq.headers.authorization).toBe("Bearer tok-rotated");

    await pollUntil(() => resolved);
    expect(loadNodeConfig(dir).node_token).toBe("tok-rotated");
    expect(loadNodeConfig(dir).previous_node_token).toBeUndefined();
  });

  it("rejects when the relay reports rotate_token_error, leaving the original token in place", async () => {
    configureNode("tok-original");
    const c = startConnection();

    const [firstConn] = await nextConnection(wss);
    await waitForMessage(firstConn); // the initial config_update sent from onOpen()
    const rotatePromise = c.rotateToken();
    await waitForMessage(firstConn);
    firstConn.send(JSON.stringify({ type: "rotate_token_error", error: "Internal error" }));

    await expect(rotatePromise).rejects.toThrow("Internal error");
    expect(loadNodeConfig(dir).node_token).toBe("tok-original");
  });

  it("rejects a second rotation request while one is already in progress", async () => {
    configureNode("tok-original");
    const c = startConnection();
    await nextConnection(wss);

    const first = c.rotateToken();
    await expect(c.rotateToken()).rejects.toThrow("already in progress");

    // Avoid an unhandled-rejection warning: the connection is torn down in afterEach
    // before the relay ever responds to this first call.
    first.catch(() => { /* expected */ });
  });
});
