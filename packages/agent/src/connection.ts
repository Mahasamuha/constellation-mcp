import type { PathEntry } from "@constellation/shared";
import type { AgentConfig } from "./config.js";
import { writeAgentToken, buildConfigUpdatePaths } from "./config.js";
import { handleRpc, type RpcEnvelope } from "./rpc.js";
import { BrokerSocket } from "./ws-broker-socket.js";

export interface ConnectionOptions {
  configDir: string;
  getConfig: () => AgentConfig;
  getPaths: () => PathEntry[];
}

export class AgentConnection extends BrokerSocket {
  constructor(private readonly opts: ConnectionOptions) {
    super({ logModule: "agent:connection", path: "/agent/connect" });
  }

  /** Sends a config_update message with the current paths. */
  sendConfigUpdate(): void {
    const paths = this.opts.getPaths();
    this.send({
      type: "config_update",
      paths: buildConfigUpdatePaths(paths),
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

  protected getBrokerUrl(): string {
    return this.opts.getConfig().broker_url;
  }

  protected getToken(): string {
    return this.opts.getConfig().agent_token;
  }

  protected onOpen(): void {
    this.sendConfigUpdate();
  }

  protected onMessage(msg: Record<string, unknown>): void {
    // RPC from broker: has request_id and tool.
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      const config = this.opts.getConfig();
      const paths = this.opts.getPaths();
      handleRpc(msg as RpcEnvelope, paths, config)
        .then((response) => this.send(response))
        .catch((err) => {
          this.log.error({ err }, "Unhandled error in RPC handler");
          this.send({ request_id: msg["request_id"], error: { message: "Internal agent error" } });
        });
      return;
    }

    const type = msg["type"];

    if (type === "token_rotated") {
      const token = msg["token"];
      if (typeof token !== "string") {
        this.log.warn("Received token_rotated without a token string");
        return;
      }
      try {
        writeAgentToken(this.opts.configDir, token);
        this.log.info("Token rotated and written to config");
        // Reconnect with the new token.
        this.ws?.close();
      } catch (err) {
        this.log.error({ err }, "Failed to write rotated token to config");
      }
      return;
    }

    if (type === "config_update_ok" || type === "update_host_ok") {
      this.log.info({ type }, "Broker acknowledged control message");
      return;
    }

    if (type === "config_update_error" || type === "update_host_error") {
      this.log.warn({ msg }, "Broker returned error for control message");
      return;
    }

    this.log.warn({ type }, "Unknown message from broker — dropping");
  }
}
