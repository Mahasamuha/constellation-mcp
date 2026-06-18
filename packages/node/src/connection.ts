import { RelaySocket, type PathEntry, type RpcEnvelope } from "@constellation/shared";
import type { NodeConfig } from "./config.js";
import { writeNodeToken, buildConfigUpdatePaths } from "./config.js";
import { handleRpc, LabelRegistryCache } from "./rpc.js";

export interface ConnectionOptions {
  configDir: string;
  getConfig: () => NodeConfig;
  getPaths: () => PathEntry[];
}

export class NodeConnection extends RelaySocket {
  private readonly registryCache = new LabelRegistryCache();

  constructor(private readonly opts: ConnectionOptions) {
    super({ logModule: "node:connection", path: "/executor/connect" });
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

  protected getRelayUrl(): string {
    return this.opts.getConfig().relay_url;
  }

  protected getToken(): string {
    return this.opts.getConfig().node_token;
  }

  protected onOpen(): void {
    this.sendConfigUpdate();
  }

  protected onMessage(msg: Record<string, unknown>): void {
    // RPC from relay: has request_id and tool.
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      const config = this.opts.getConfig();
      const paths = this.opts.getPaths();
      handleRpc(msg as RpcEnvelope, paths, config, this.registryCache)
        .then((response) => this.send(response))
        .catch((err) => {
          this.log.error({ err }, "Unhandled error in RPC handler");
          this.send({ request_id: msg["request_id"], error: { message: "Internal node error" } });
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
        writeNodeToken(this.opts.configDir, token);
        this.log.info("Token rotated and written to config");
        // Reconnect with the new token.
        this.ws?.close();
      } catch (err) {
        this.log.error({ err }, "Failed to write rotated token to config");
      }
      return;
    }

    if (type === "config_update_ok" || type === "update_host_ok") {
      this.log.info({ type }, "Relay acknowledged control message");
      return;
    }

    if (type === "config_update_error" || type === "update_host_error") {
      this.log.warn({ msg }, "Relay returned error for control message");
      return;
    }

    this.log.warn({ type }, "Unknown message from relay — dropping");
  }
}
