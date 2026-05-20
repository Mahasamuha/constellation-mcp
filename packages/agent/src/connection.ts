import WebSocket from "ws";
import { createLogger } from "@constellation/shared";
import type { AgentConfig, PathEntry } from "./config.js";
import { writeAgentToken } from "./config.js";
import { handleRpc, type RpcEnvelope } from "./rpc.js";

const log = createLogger("agent:connection");

const INITIAL_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FACTOR = 0.2;
const MAX_DELAY_MS = 60_000;

export interface ConnectionOptions {
  configDir: string;
  getConfig: () => AgentConfig;
  getPaths: () => PathEntry[];
}

export class AgentConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private delay = INITIAL_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: ConnectionOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Sends a config_update message with the current paths. */
  sendConfigUpdate(): void {
    const paths = this.opts.getPaths();
    this.send({
      type: "config_update",
      paths: paths.map((p) => ({ label: p.label, reported_path: p.path })),
    });
  }

  /** Sends an update_host message. */
  sendUpdateHost(host: string): void {
    this.send({ type: "update_host", host });
  }

  /** Sends a rotate_token request. */
  sendRotateToken(): void {
    this.send({ type: "rotate_token" });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      log.warn("Cannot send — not connected");
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const config = this.opts.getConfig();
    const url = config.broker_url.replace(/^http/, "ws");

    log.info({ url }, "Connecting to broker");

    const ws = new WebSocket(url + "/agent/connect", {
      headers: { Authorization: `Bearer ${config.agent_token}` },
    });

    this.ws = ws;

    ws.on("open", () => {
      log.info("Connected to broker");
      this.delay = INITIAL_DELAY_MS;
      this.sendConfigUpdate();
    });

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log.warn("Received non-JSON message from broker");
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("close", (code, reason) => {
      log.info({ code, reason: reason.toString() }, "Disconnected from broker");
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error({ err }, "WebSocket error");
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // RPC from broker: has request_id and tool.
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      const config = this.opts.getConfig();
      const paths = this.opts.getPaths();
      handleRpc(msg as RpcEnvelope, paths, config)
        .then((response) => this.send(response))
        .catch((err) => {
          log.error({ err }, "Unhandled error in RPC handler");
          this.send({ request_id: msg["request_id"], error: "Internal agent error" });
        });
      return;
    }

    const type = msg["type"];

    if (type === "token_rotated") {
      const token = msg["token"];
      if (typeof token !== "string") {
        log.warn("Received token_rotated without a token string");
        return;
      }
      try {
        writeAgentToken(this.opts.configDir, token);
        log.info("Token rotated and written to config");
        // Reconnect with the new token.
        this.ws?.close();
      } catch (err) {
        log.error({ err }, "Failed to write rotated token to config");
      }
      return;
    }

    if (type === "config_update_ok" || type === "update_host_ok") {
      log.info({ type }, "Broker acknowledged control message");
      return;
    }

    if (type === "config_update_error" || type === "update_host_error") {
      log.warn({ msg }, "Broker returned error for control message");
      return;
    }

    log.warn({ type }, "Unknown message from broker — dropping");
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const jitter = (Math.random() * 2 - 1) * JITTER_FACTOR * this.delay;
    const next = Math.min(this.delay + jitter, MAX_DELAY_MS);

    log.info({ delayMs: Math.round(next) }, "Reconnecting");

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, next);

    this.delay = Math.min(this.delay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
  }
}
