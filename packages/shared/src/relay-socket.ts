import WebSocket from "ws";
import { createLogger } from "./logger.js";

const INITIAL_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FACTOR = 0.2;
const MAX_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
/** Bounds how long stop() waits for the close handshake to actually complete before
 * giving up and returning anyway — shorter than PING_TIMEOUT_MS, since this is just
 * waiting on a clean close, not detecting a wedged connection. */
const STOP_CLOSE_TIMEOUT_MS = 5_000;

export interface RelaySocketOptions {
  /** Module name passed to createLogger, e.g. "node:connection" or "hub". */
  logModule: string;
  /** WebSocket path appended after the ws(s)://host:port, e.g. "/executor/connect". */
  path: string;
}

/** True for localhost, any 127.0.0.0/8 loopback address, or ::1 (bracketed or not). */
function isLocalHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  return /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Throws if `wsUrl` is a plaintext ws:// URL targeting a non-localhost host.
 * The bearer token sent in the Authorization header must never cross the
 * network unencrypted. Call this before constructing *any* WebSocket
 * connection to a relay — the long-lived RelaySocket connection below and
 * every short-lived CLI control-plane connection (token rotation, rename,
 * sync) alike. A second, independently-constructed WebSocket that skips this
 * check defeats the whole point of enforcing it here.
 */
export function assertSecureRelayUrl(wsUrl: string): void {
  if (!wsUrl.startsWith("ws://")) return;
  const hostname = new URL(wsUrl).hostname;
  if (isLocalHostname(hostname)) return;
  throw new Error(
    `Refusing to connect: relay URL uses ws:// for a non-localhost host (${hostname}). Use wss:// to protect the access token.`
  );
}

/** Throws if `httpUrl` is a plaintext http:// URL targeting a non-localhost host.
 * Bearer tokens sent in Authorization headers must never cross the network
 * unencrypted. Call this before any fetch() that carries an access token. */
export function assertSecureHttpUrl(httpUrl: string): void {
  if (!httpUrl.startsWith("http://")) return;
  const hostname = new URL(httpUrl).hostname;
  if (isLocalHostname(hostname)) return;
  throw new Error(
    `Refusing to connect: relay URL uses http:// for a non-localhost host (${hostname}). Use https:// to protect the access token.`
  );
}

/** Returns true if `targetUrl` shares the same origin as `relayUrl`.
 * Use this to validate server-supplied redirect/verification URLs before
 * opening them in a browser, preventing a compromised relay from redirecting
 * to an arbitrary URI scheme or host. */
export function isSameOrigin(relayUrl: string, targetUrl: string): boolean {
  try {
    const relay = new URL(relayUrl);
    const target = new URL(targetUrl);
    return relay.origin === target.origin;
  } catch {
    return false;
  }
}

/**
 * Shared transport for the relay WebSocket connection.
 *
 * Both the personal node (NodeConnection) and the hub (HubSocket) connect to
 * the same `/executor/connect` endpoint and need identical connection-lifecycle
 * handling: deriving the ws(s) URL and refusing ws:// to non-localhost hosts,
 * exponential-backoff reconnect with jitter, ping/pong keepalive with
 * timeout-triggered termination, and JSON message framing. That machinery
 * lives here so a fix (e.g. the ws:// guard) only has to be made once.
 *
 * Subclasses provide the relay URL/token, what to send once connected, and
 * how to route incoming messages — everything that's actually specific to the
 * node-vs-hub modality.
 */
export abstract class RelaySocket {
  protected ws: WebSocket | null = null;
  protected readonly log: ReturnType<typeof createLogger>;

  private readonly path: string;
  private stopped = false;
  private delay = INITIAL_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelaySocketOptions) {
    this.log = createLogger(opts.logModule);
    this.path = opts.path;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /**
   * Stops reconnecting and closes the live socket, resolving once the close handshake
   * actually completes (bounded by STOP_CLOSE_TIMEOUT_MS) instead of just firing the
   * close frame and returning immediately. Callers that need a clean shutdown — the
   * relay seeing a real close instead of an abrupt drop, control.json/other cleanup
   * tied to "the connection is fully gone" — should await this before exiting.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearPingTimers();

    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_CLOSE_TIMEOUT_MS);
      ws.once("close", () => { clearTimeout(timer); resolve(); });
      ws.close();
    });
  }

  protected isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  protected send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.log.warn("Cannot send — not connected");
    }
  }

  /** The relay's base URL (http(s)://...) — converted to ws(s):// internally. */
  protected abstract getRelayUrl(): string;
  /** The bearer token to authenticate the connection with. */
  protected abstract getToken(): string;
  /** Called once the socket is open and the reconnect delay has been reset. Send any initial sync payload here. */
  protected abstract onOpen(): void;
  /** Called for each parsed JSON message received from the relay. */
  protected abstract onMessage(msg: Record<string, unknown>): void;
  /** Called when the socket closes, before a reconnect is scheduled. Optional hook. */
  protected onClose(): void { /* no-op by default */ }

  private clearPingTimers(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.pingTimeoutTimer) { clearTimeout(this.pingTimeoutTimer); this.pingTimeoutTimer = null; }
  }

  private connect(): void {
    if (this.stopped) return;

    const wsUrl = this.getRelayUrl().replace(/^http/, "ws");

    try {
      assertSecureRelayUrl(wsUrl);
    } catch (err) {
      this.log.error({ url: wsUrl }, (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    this.log.info({ url: wsUrl }, "Connecting to relay");

    const ws = new WebSocket(wsUrl + this.path, {
      headers: { Authorization: `Bearer ${this.getToken()}` },
      maxPayload: 1_048_576,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.log.info("Connected to relay");
      this.delay = INITIAL_DELAY_MS;
      this.onOpen();

      this.pingInterval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
        this.pingTimeoutTimer = setTimeout(() => {
          this.log.warn("Ping timeout — terminating connection");
          ws.terminate();
        }, PING_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    });

    ws.on("pong", () => {
      if (this.pingTimeoutTimer) { clearTimeout(this.pingTimeoutTimer); this.pingTimeoutTimer = null; }
    });

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        this.log.warn("Received non-JSON message from relay");
        return;
      }
      this.onMessage(msg);
    });

    ws.on("close", (code, reason) => {
      this.log.info({ code, reason: reason.toString() }, "Disconnected from relay");
      this.clearPingTimers();
      this.ws = null;
      this.onClose();
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.log.error({ err }, "WebSocket error");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const jitter = (Math.random() * 2 - 1) * JITTER_FACTOR * this.delay;
    const next = Math.min(this.delay + jitter, MAX_DELAY_MS);

    this.log.info({ delayMs: Math.round(next) }, "Reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, next);

    this.delay = Math.min(this.delay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
  }
}
