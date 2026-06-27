import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSideSocket } from "ws";
import { RelaySocket, type RelaySocketOptions, assertSecureRelayUrl } from "./relay-socket.js";

describe("assertSecureRelayUrl", () => {
  it("never throws for wss://, regardless of host", () => {
    expect(() => assertSecureRelayUrl("wss://example.com:1234/connect")).not.toThrow();
  });

  it.each(["localhost", "127.0.0.1", "127.5.2.9", "[::1]"])(
    "allows ws:// to local host %s",
    (host) => {
      expect(() => assertSecureRelayUrl(`ws://${host}:1234/connect`)).not.toThrow();
    }
  );

  it("refuses ws:// to a remote host", () => {
    expect(() => assertSecureRelayUrl("ws://example.com:1234/connect")).toThrow(/non-localhost host/);
  });
});

// Mirrors the private constants in relay-socket.ts.
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const STOP_CLOSE_TIMEOUT_MS = 5_000;

class TestRelaySocket extends RelaySocket {
  opens = 0;
  closes = 0;
  messages: Record<string, unknown>[] = [];

  constructor(opts: RelaySocketOptions & { relayUrl: string }) {
    super(opts);
    this.relayUrl = opts.relayUrl;
  }

  private relayUrl: string;

  protected getRelayUrl(): string { return this.relayUrl; }
  protected getToken(): string { return "test-token"; }
  protected onOpen(): void { this.opens++; this.send({ type: "hello" }); }
  protected onMessage(msg: Record<string, unknown>): void { this.messages.push(msg); }
  protected onClose(): void { this.closes++; }
}

/** Yields one real event-loop turn — used instead of vi.waitFor's polling so that detection
 * still works correctly when fake timers are active (vi.waitFor polls via the same timer
 * functions a test may have faked, and would otherwise stall waiting on real I/O). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Polls `condition` once per real event-loop turn until it's true or `timeoutMs` (real wall
 * clock — Date is never faked here) elapses. Safe to use whether or not fake timers are active. */
async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await flush();
  }
}

function nextConnection(server: WebSocketServer): Promise<ServerSideSocket> {
  return new Promise((resolve) => server.once("connection", resolve));
}

/** Waits for the server-side connection, then for the client's own "open" handler to have run.
 * The server's "connection" event fires before the client receives the upgrade response and
 * sends anything — so any listener that needs to observe what the client sends on open must be
 * attached on the returned socket before this resolves; capture it from the "connection" event
 * directly rather than waiting on this helper first. */
async function waitForOpen(server: WebSocketServer, socket: TestRelaySocket, expectedOpens: number): Promise<ServerSideSocket> {
  const conn = await nextConnection(server);
  await pollUntil(() => socket.opens === expectedOpens);
  return conn;
}

describe("RelaySocket", () => {
  let wss: WebSocketServer;
  let port: number;
  let sockets: TestRelaySocket[];

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
    sockets = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const s of sockets) s.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function makeSocket(relayUrl: string): TestRelaySocket {
    const socket = new TestRelaySocket({ logModule: "test", path: "/connect", relayUrl });
    sockets.push(socket);
    return socket;
  }

  it("connects, authenticates with the bearer token, and exchanges JSON messages", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    const connPromise = nextConnection(wss);
    socket.start();

    // Attach the listener before the client can possibly have sent anything — the server's
    // "connection" event always fires before the client's "open" (and thus before its initial
    // send), so this can't race the message the client sends from onOpen.
    const ws = await connPromise;
    const firstMessage = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    });

    expect(await firstMessage).toEqual({ type: "hello" });
    expect(socket.opens).toBe(1);

    ws.send(JSON.stringify({ type: "ack" }));
    await pollUntil(() => socket.messages.some((m) => m["type"] === "ack"));
  });

  it("ignores non-JSON messages instead of throwing", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    socket.start();
    const ws = await waitForOpen(wss, socket, 1);

    ws.send("not json");
    ws.send(JSON.stringify({ type: "after-garbage" }));

    await pollUntil(() => socket.messages.some((m) => m["type"] === "after-garbage"));
    expect(socket.messages).toHaveLength(1);
  });

  it("refuses to connect over ws:// to a non-localhost host", async () => {
    const socket = makeSocket("http://example.com:1234");
    socket.start();

    await flush();
    expect(socket.opens).toBe(0);
  });

  it.each(["localhost", "127.0.0.1"])("allows ws:// to %s", async (host) => {
    const socket = makeSocket(`http://${host}:${port}`);
    socket.start();
    await waitForOpen(wss, socket, 1);
  });

  it("reconnects with the initial backoff delay after the relay closes the connection", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    socket.start();
    const firstWs = await waitForOpen(wss, socket, 1);

    const secondConn = nextConnection(wss);
    firstWs.close();

    await pollUntil(() => socket.closes === 1);
    await secondConn;
    await pollUntil(() => socket.opens === 2);
  }, 5000);

  it("sends a ping after the interval and clears the pending timeout once a pong arrives", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    const connPromise = nextConnection(wss);

    // Fake timers must be active *before* start() — the ping interval is registered with
    // setInterval inside the "open" handler, and faking timers afterwards wouldn't retroactively
    // convert an already-scheduled real interval into a fake one.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      socket.start();
      const ws = await connPromise;
      await pollUntil(() => socket.opens === 1);

      const pinged = new Promise<void>((resolve) => ws.once("ping", () => resolve()));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await pinged;

      ws.pong();
      await flush();

      // The pong should have cleared the pending timeout — advancing past it
      // must not terminate the connection.
      await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
      await flush();
      expect(socket.closes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the connection if no pong arrives within the timeout", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    const connPromise = nextConnection(wss);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let conn: ServerSideSocket | undefined;
    try {
      socket.start();
      conn = await connPromise;
      // ws auto-responds to a received ping with a pong at the protocol level — pausing the
      // socket stops it from processing any incoming frames at all, the only way to simulate a
      // peer that's stopped responding rather than one that's cleanly gone away.
      conn.pause();
      await pollUntil(() => socket.opens === 1);

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await flush();
      await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
      await pollUntil(() => socket.closes === 1);
    } finally {
      vi.useRealTimers();
      conn?.terminate();
    }
  });

  it("does not reconnect after stop() is called", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    socket.start();
    const firstWs = await waitForOpen(wss, socket, 1);

    socket.stop();
    firstWs.close();
    await flush();

    // Give a generous window for a (unwanted) reconnect attempt to show up.
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.opens).toBe(1);
  });

  // Regression test for the daemon-shutdown fix: stop() used to fire the close frame
  // and return immediately, so a caller had no way to know the relay had actually seen
  // a clean close rather than an abrupt drop.
  it("stop() resolves only once the close handshake actually completes", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    socket.start();
    const firstWs = await waitForOpen(wss, socket, 1);

    let serverSawClose = false;
    firstWs.on("close", () => { serverSawClose = true; });

    await socket.stop();
    expect(serverSawClose).toBe(true);
  });

  it("stop() gives up and resolves anyway if the close handshake never completes", async () => {
    const socket = makeSocket(`http://127.0.0.1:${port}`);
    const connPromise = nextConnection(wss);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let conn: ServerSideSocket | undefined;
    try {
      socket.start();
      conn = await connPromise;
      // Same trick as the pong-timeout test above: pausing the peer's socket stops it
      // from ever acknowledging the close frame, so the handshake never completes on
      // its own — stop() must fall back to its bounded timeout instead of hanging.
      conn.pause();
      await pollUntil(() => socket.opens === 1);

      let resolved = false;
      const stopPromise = socket.stop().then(() => { resolved = true; });

      await flush();
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(STOP_CLOSE_TIMEOUT_MS);
      await stopPromise;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
      conn?.terminate();
    }
  });
});
