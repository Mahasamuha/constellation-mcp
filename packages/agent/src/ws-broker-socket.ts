import WebSocket from "ws";
import { createLogger } from "@constellation/shared";

const INITIAL_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FACTOR = 0.2;
const MAX_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

export interface BrokerSocketOptions {
  /** Module name passed to createLogger, e.g. "agent:connection" or "agent:shared". */
  logModule: string;
  /** WebSocket path appended after the ws(s)://host:port, e.g. "/agent/connect". */
  path: string;
}

/**
 * Shared transport for the broker WebSocket connection.
 *
 * Both the personal agent (AgentConnection) and the shared agent connect to
 * the same `/agent/connect` endpoint and need identical connection-lifecycle
 * handling: deriving the ws(s) URL and refusing ws:// to non-localhost hosts,
 * exponential-backoff reconnect with jitter, ping/pong keepalive with
 * timeout-triggered termination, and JSON message framing. That machinery
 * lives here so a fix (e.g. the ws:// guard) only has to be made once.
 *
 * Subclasses provide the broker URL/token, what to send once connected, and
 * how to route incoming messages — everything that's actually specific to the
 * personal-vs-shared modality.
 */
export abstract class BrokerSocket {
  protected ws: WebSocket | null = null;
  protected readonly log: ReturnType<typeof createLogger>;

  private readonly path: string;
  private stopped = false;
  private delay = INITIAL_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BrokerSocketOptions) {
    this.log = createLogger(opts.logModule);
    this.path = opts.path;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearPingTimers();
    this.ws?.close();
    this.ws = null;
  }

  protected send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.log.warn("Cannot send — not connected");
    }
  }

  /** The broker's base URL (http(s)://...) — converted to ws(s):// internally. */
  protected abstract getBrokerUrl(): string;
  /** The bearer token to authenticate the connection with. */
  protected abstract getToken(): string;
  /** Called once the socket is open and the reconnect delay has been reset. Send any initial sync payload here. */
  protected abstract onOpen(): void;
  /** Called for each parsed JSON message received from the broker. */
  protected abstract onMessage(msg: Record<string, unknown>): void;
  /** Called when the socket closes, before a reconnect is scheduled. Optional hook. */
  protected onClose(): void { /* no-op by default */ }

  private clearPingTimers(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.pingTimeoutTimer) { clearTimeout(this.pingTimeoutTimer); this.pingTimeoutTimer = null; }
  }

  private connect(): void {
    if (this.stopped) return;

    const wsUrl = this.getBrokerUrl().replace(/^http/, "ws");

    if (wsUrl.startsWith("ws://")) {
      const host = new URL(wsUrl).hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocal) {
        this.log.error({ url: wsUrl }, "Refusing to connect: broker URL uses ws:// for a non-localhost host. Use wss:// to protect the agent token.");
        this.scheduleReconnect();
        return;
      }
    }

    this.log.info({ url: wsUrl }, "Connecting to broker");

    const ws = new WebSocket(wsUrl + this.path, {
      headers: { Authorization: `Bearer ${this.getToken()}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.log.info("Connected to broker");
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
        this.log.warn("Received non-JSON message from broker");
        return;
      }
      this.onMessage(msg);
    });

    ws.on("close", (code, reason) => {
      this.log.info({ code, reason: reason.toString() }, "Disconnected from broker");
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
