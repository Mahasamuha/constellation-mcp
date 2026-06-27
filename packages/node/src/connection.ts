import { RelaySocket, type PathEntry, type RpcEnvelope } from "@constellation/shared";
import type { NodeConfig } from "./config.js";
import { writeNodeToken, clearPreviousToken, buildConfigUpdatePaths } from "./config.js";
import { handleRpc, ShareRegistryCache } from "./rpc.js";

export interface ConnectionOptions {
  configDir: string;
  getConfig: () => NodeConfig;
  getPaths: () => PathEntry[];
}

/** Bounds how long rotateToken() waits for the relay's reply and, separately, for the
 * resulting reconnect to succeed — comfortably under the relay's pending-rotation TTL
 * (5 minutes, see docs/architecture.md) so a caller never hangs past the point where the
 * rotation would have expired server-side anyway. */
const ROTATE_TIMEOUT_MS = 30_000;

const CONTROL_OP_TIMEOUT_MS = 15_000;

interface RotationState {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NodeConnection extends RelaySocket {
  private readonly registryCache = new ShareRegistryCache();
  private rotationState: RotationState | null = null;
  private awaitingRotationConfirm = false;
  private configUpdateState: RotationState | null = null;
  private updateHostState: RotationState | null = null;

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

  /** Sends a config_update on the live connection and resolves once the relay ACKs. */
  configUpdate(paths: PathEntry[]): Promise<void> {
    if (this.configUpdateState) {
      return Promise.reject(new Error("A config update is already in progress"));
    }
    if (!this.isConnected()) {
      return Promise.reject(new Error("Not connected to relay"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configUpdateState = null;
        reject(new Error("Timed out waiting for config_update acknowledgment"));
      }, CONTROL_OP_TIMEOUT_MS);
      this.configUpdateState = { resolve, reject, timer };
      this.send({ type: "config_update", paths: buildConfigUpdatePaths(paths) });
    });
  }

  /** Sends an update_host on the live connection and resolves once the relay ACKs. */
  updateHost(host: string): Promise<void> {
    if (this.updateHostState) {
      return Promise.reject(new Error("A host update is already in progress"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.updateHostState = null;
        reject(new Error("Timed out waiting for update_host acknowledgment"));
      }, CONTROL_OP_TIMEOUT_MS);
      this.updateHostState = { resolve, reject, timer };
      this.send({ type: "update_host", host });
    });
  }

  /**
   * Drives the documented node-initiated rotation handshake on this live connection:
   * requests a new token, writes it once the relay grants it, and waits for the resulting
   * reconnect (triggered by closing this socket) to actually succeed before resolving.
   * Rejects if the relay refuses the request, or if confirmation doesn't arrive within
   * ROTATE_TIMEOUT_MS.
   */
  rotateToken(): Promise<void> {
    if (this.rotationState) {
      return Promise.reject(new Error("A token rotation is already in progress"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rotationState = null;
        this.awaitingRotationConfirm = false;
        reject(new Error("Timed out waiting for rotation to complete"));
      }, ROTATE_TIMEOUT_MS);
      this.rotationState = { resolve, reject, timer };
      this.send({ type: "rotate_token" });
    });
  }

  /** Settles any in-flight rotateToken() call with a failure — used for relay-reported
   * errors and for cleanup if the connection is stopped mid-rotation. */
  private failRotation(err: Error): void {
    if (!this.rotationState) return;
    clearTimeout(this.rotationState.timer);
    const { reject } = this.rotationState;
    this.rotationState = null;
    this.awaitingRotationConfirm = false;
    reject(err);
  }

  override async stop(): Promise<void> {
    this.failRotation(new Error("Connection stopped"));
    if (this.configUpdateState) {
      clearTimeout(this.configUpdateState.timer);
      this.configUpdateState.reject(new Error("Connection stopped"));
      this.configUpdateState = null;
    }
    if (this.updateHostState) {
      clearTimeout(this.updateHostState.timer);
      this.updateHostState.reject(new Error("Connection stopped"));
      this.updateHostState = null;
    }
    await super.stop();
  }

  protected getRelayUrl(): string {
    return this.opts.getConfig().relay_url;
  }

  protected getToken(): string {
    return this.opts.getConfig().node_token;
  }

  protected onOpen(): void {
    this.sendConfigUpdate();
    if (this.awaitingRotationConfirm) {
      this.awaitingRotationConfirm = false;
      clearPreviousToken(this.opts.configDir);
      if (this.rotationState) {
        clearTimeout(this.rotationState.timer);
        const { resolve } = this.rotationState;
        this.rotationState = null;
        resolve();
      }
    }
  }

  protected onMessage(msg: Record<string, unknown>): void {
    // RPC from relay: has request_id and tool.
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      let config: NodeConfig;
      let paths: PathEntry[];
      try {
        config = this.opts.getConfig();
        paths = this.opts.getPaths();
      } catch (err) {
        // node.yaml/paths.yaml is mid-edit, deleted, or malformed — fail this one RPC
        // instead of crashing the daemon (no try/catch surrounds RelaySocket's onMessage call).
        this.log.error({ err }, "Failed to load node config while handling RPC");
        this.send({ request_id: msg["request_id"], error: { message: "Internal node error" } });
        return;
      }
      handleRpc(msg as unknown as RpcEnvelope, paths, config, this.registryCache)
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
        this.failRotation(new Error("Relay sent token_rotated without a token"));
        return;
      }
      try {
        writeNodeToken(this.opts.configDir, token);
        this.log.info("Token rotated and written to config — reconnecting to confirm");
        // Reconnect with the new token; onOpen() resolves the pending rotateToken() call
        // once this reconnect actually succeeds.
        this.awaitingRotationConfirm = true;
        this.ws?.close();
      } catch (err) {
        this.log.error({ err }, "Failed to write rotated token to config");
        this.failRotation(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    if (type === "rotate_token_error") {
      const err = new Error(String(msg["error"] ?? "Token rotation failed"));
      this.log.warn({ err }, "Relay rejected rotate_token");
      this.failRotation(err);
      return;
    }

    if (type === "config_update_ok") {
      this.log.info({ type }, "Relay acknowledged config_update");
      if (this.configUpdateState) {
        clearTimeout(this.configUpdateState.timer);
        const { resolve } = this.configUpdateState;
        this.configUpdateState = null;
        resolve();
      }
      return;
    }

    if (type === "config_update_error") {
      this.log.warn({ msg }, "Relay rejected config_update");
      if (this.configUpdateState) {
        clearTimeout(this.configUpdateState.timer);
        const { reject } = this.configUpdateState;
        this.configUpdateState = null;
        reject(new Error(String(msg["error"] ?? "config_update failed")));
      }
      return;
    }

    if (type === "update_host_ok") {
      this.log.info({ type }, "Relay acknowledged update_host");
      if (this.updateHostState) {
        clearTimeout(this.updateHostState.timer);
        const { resolve } = this.updateHostState;
        this.updateHostState = null;
        resolve();
      }
      return;
    }

    if (type === "update_host_error") {
      this.log.warn({ msg }, "Relay rejected update_host");
      if (this.updateHostState) {
        clearTimeout(this.updateHostState.timer);
        const { reject } = this.updateHostState;
        this.updateHostState = null;
        reject(new Error(String(msg["error"] ?? "update_host failed")));
      }
      return;
    }

    this.log.warn({ type }, "Unknown message from relay — dropping");
  }
}
