import { checkSharePath } from "./paths.js";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import {
  createLogger,
  MAX_SHARE_INSTRUCTIONS_LENGTH,
  RelaySocket,
  startControlServer,
  type RpcEnvelope,
  type RotatableConnection,
} from "@constellation/shared";
import { loadHubConfig, validateHubConfig, type HubConfig } from "./config.js";
import { resolveIdentity, isIdentityError } from "./identity.js";
import { checkRpcPermission, buildPermissionBlob } from "./permissions.js";
import { AuditWriter } from "./audit.js";
import { SubnodePool, isDispatchError } from "./subnode.js";

const log = createLogger("hub");

/** Relay forwards these on every envelope it dispatches, for OS-identity resolution
 * below — defined locally (mirroring relay's own RpcEnvelope extension) rather than
 * imported from @constellation/relay, which hub has no reason to depend on. */
interface IncomingRpcEnvelope extends RpcEnvelope {
  user_oidc_sub: string | null;
  user_claims: Record<string, unknown>;
}

/** Bounds how long rotateToken() waits for the relay's reply and, separately, for the
 * resulting reconnect to succeed — comfortably under the relay's pending-rotation TTL
 * (5 minutes) so a caller never hangs past the point where the rotation would have
 * expired server-side anyway. Mirrors node/src/connection.ts's identical constant. */
const ROTATE_TIMEOUT_MS = 30_000;

interface RotationState {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Env file sourcing
// ---------------------------------------------------------------------------

export function sourceEnvFile(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read env_file '${path}': ${(err as Error).message}`, { cause: err });
  }

  // Warn if file permissions are too broad
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    if (mode & 0o004) {
      process.stderr.write(`WARNING: env_file '${path}' is world-readable (mode ${mode.toString(8)}). Restrict to 600.\n`);
    } else if (mode & 0o040) {
      process.stderr.write(`WARNING: env_file '${path}' is group-readable (mode ${mode.toString(8)}). Consider restricting to 600.\n`);
    }
  } catch { /* stat failure is non-fatal */ }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Hub share sync payload
// ---------------------------------------------------------------------------

function buildHubShareSyncPayload(cfg: HubConfig, shareRegistry: Record<string, string>): object {
  return {
    type: "hub_share_sync",
    shares: cfg.shares
      .filter((s) => shareRegistry[s.name] !== undefined)
      .map((s) => {
        const entry: { name: string; reported_path: string; permission_blob: object; instructions?: string } = {
          name: s.name,
          reported_path: shareRegistry[s.name]!,
          permission_blob: buildPermissionBlob(s),
        };

        let instructions: string | undefined;
        if (s.instructions) {
          instructions = s.instructions;
        } else if (s.context_file) {
          try {
            instructions = readFileSync(s.context_file, "utf8");
          } catch {
            log.info({ share: s.name, context_file: s.context_file }, "context_file is set but could not be read — omitting instructions");
          }
        }

        if (instructions !== undefined) {
          if (instructions.length > MAX_SHARE_INSTRUCTIONS_LENGTH) {
            log.warn(
              { share: s.name, length: instructions.length, max: MAX_SHARE_INSTRUCTIONS_LENGTH },
              "instructions exceeds maximum length — dropping"
            );
          } else {
            entry.instructions = instructions;
          }
        }
        return entry;
      }),
  };
}

// ---------------------------------------------------------------------------
// Hub socket
// ---------------------------------------------------------------------------

/**
 * Relay connection for the hub. Extends RelaySocket — see that module for the
 * connection lifecycle (reconnect/backoff, ping/pong, ws:// guard) shared
 * with the personal node's connection. This class adds what's specific to
 * the hub modality: share sync on connect, resolving each RPC to an OS
 * identity, permission checks, subnode dispatch, audit logging, and
 * graceful drain-on-shutdown.
 */
export class HubSocket extends RelaySocket implements RotatableConnection {
  private shuttingDown = false;
  private rotationState: RotationState | null = null;
  private awaitingRotationConfirm = false;
  private readonly audit: AuditWriter;

  constructor(
    private readonly cfg: HubConfig,
    private hubToken: string,
    private readonly shareRegistry: Record<string, string>,
    private readonly pool: SubnodePool
  ) {
    super({ logModule: "hub", path: "/executor/connect" });
    this.audit = new AuditWriter(cfg.audit_log);
  }

  protected getRelayUrl(): string {
    return this.cfg.relay_url;
  }

  protected getToken(): string {
    return this.hubToken;
  }

  /**
   * Drives the same daemon-initiated rotation handshake `node` uses: requests a new
   * token on this live connection, persists it to env_file and adopts it in place once
   * the relay grants it, and waits for the resulting reconnect (triggered by closing
   * this socket) to actually succeed before resolving. Unlike node, hub's token is
   * deliberately kept out of the main config object (see docs/hub.md's "subnode workers
   * never inherit the parent's environment" note) — env_file is where it's persisted
   * across a future cold start, but this in-memory field is updated immediately so the
   * very next reconnect uses it, with no restart required.
   */
  rotateToken(): Promise<void> {
    if (!this.cfg.env_file) {
      return Promise.reject(new Error("No env_file configured — cannot persist a rotated token across a restart"));
    }
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
    await super.stop();
  }

  protected onOpen(): void {
    this.log.info({ hubName: this.cfg.hub_name }, "Connected to relay");
    this.send(buildHubShareSyncPayload(this.cfg, this.shareRegistry));
    if (this.awaitingRotationConfirm) {
      this.awaitingRotationConfirm = false;
      if (this.rotationState) {
        clearTimeout(this.rotationState.timer);
        const { resolve } = this.rotationState;
        this.rotationState = null;
        resolve();
      }
    }
  }

  protected onMessage(msg: Record<string, unknown>): void {
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      if (this.shuttingDown) {
        this.send({ request_id: msg["request_id"], error: { message: "HUB_SHUTTING_DOWN — retry after 45 seconds" } });
        return;
      }
      this.handleRpc(msg as unknown as IncomingRpcEnvelope)
        .then((response) => this.send(response))
        .catch((err) => {
          this.log.error({ err }, "Unhandled error in RPC handler");
          this.send({ request_id: msg["request_id"], error: { message: "Internal hub error" } });
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
      if (!this.cfg.env_file) {
        // rotateToken() already refuses to start a rotation without env_file configured,
        // so this should be unreachable in practice — defensive only.
        this.log.error("Received token_rotated but no env_file is configured to persist it");
        this.failRotation(new Error("No env_file configured to persist the rotated token"));
        return;
      }
      try {
        writeTokenToEnvFile(this.cfg.env_file, token);
      } catch (err) {
        this.log.error({ err }, "Failed to write rotated token to env_file");
        this.failRotation(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.hubToken = token;
      this.log.info("Token rotated and persisted to env_file — reconnecting to confirm");
      // Reconnect with the new token; onOpen() resolves the pending rotateToken() call
      // once this reconnect actually succeeds.
      this.awaitingRotationConfirm = true;
      this.ws?.close();
      return;
    }

    if (type === "rotate_token_error") {
      const err = new Error(String(msg["error"] ?? "Token rotation failed"));
      this.log.warn({ err }, "Relay rejected rotate_token");
      this.failRotation(err);
      return;
    }

    if (type === "hub_share_sync_ok") {
      this.log.info("Relay acknowledged share sync");
      return;
    }

    if (type === "hub_share_sync_error") {
      this.log.warn({ error: msg["error"] }, "Relay returned error for share sync");
      return;
    }

    if (type === "config_update_ok" || type === "config_update_error") {
      // Expected rejection for hubs; ignore
      return;
    }

    this.log.warn({ type }, "Unknown message from relay — dropping");
  }

  private async handleRpc(envelope: IncomingRpcEnvelope): Promise<object> {
    const { request_id, tool, params, user_oidc_sub: userOidcSub, user_claims: userClaims } = envelope;
    const share = envelope.share || guessShare(envelope.absolute_root, this.shareRegistry);

    // onMessage casts the raw WS message to IncomingRpcEnvelope after checking only that
    // request_id/tool are strings — params isn't validated there. Without this guard, a
    // non-object params throws deep inside resolveDstShare below, which skips every
    // this.audit.write call in this function entirely (onMessage's catch-all handler logs
    // and replies with an error, but knows nothing about the audit log's shape).
    if (typeof params !== "object" || params === null) {
      const message = "Malformed request: params must be an object";
      this.log.warn({ request_id, tool, share }, message);
      this.audit.write({
        ts: new Date().toISOString(),
        hub_name: this.cfg.hub_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: null,
        share,
        tool,
        outcome: "exec_error",
        error: message,
      });
      return { request_id, error: { message } };
    }

    // Resolve OS identity
    const identity = await resolveIdentity(userClaims, userOidcSub, this.cfg.identity);

    if (isIdentityError(identity)) {
      this.log.warn({ request_id, tool, share, error: identity.message }, "Identity resolution failed");
      this.audit.write({
        ts: new Date().toISOString(),
        hub_name: this.cfg.hub_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: null,
        share,
        tool,
        outcome: "identity_error",
        error: identity.message,
      });
      return { request_id, error: { message: identity.message } };
    }

    // Check permissions — for cross-share copy/move, the destination share is checked too.
    const dstShare = resolveDstShare(envelope, tool, this.shareRegistry);
    const permission = checkRpcPermission(userOidcSub, share, dstShare, tool, this.cfg.shares);
    if (!permission.permitted) {
      return this.permissionDenied(request_id, tool, permission.share, userOidcSub, identity.username, permission.reason);
    }

    // Dispatch to subnode
    const dispatchResult = await this.pool.dispatch(identity, tool, share, params, request_id);

    if (isDispatchError(dispatchResult)) {
      this.log.warn({ request_id, tool, share, username: identity.username, kind: dispatchResult.kind, error: dispatchResult.message }, "Subnode dispatch failed");
      this.audit.write({
        ts: new Date().toISOString(),
        hub_name: this.cfg.hub_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: identity.username,
        share,
        tool,
        outcome: dispatchResult.kind,
        error: dispatchResult.message,
      });
      return { request_id, error: { message: dispatchResult.message } };
    }

    const outcome = dispatchResult.error ? "exec_error" : "ok";
    const errorMsg = dispatchResult.error
      ? (typeof dispatchResult.error === "object" && dispatchResult.error !== null
          ? String((dispatchResult.error as Record<string, unknown>)["message"] ?? JSON.stringify(dispatchResult.error))
          : String(dispatchResult.error))
      : null;

    this.audit.write({
      ts: new Date().toISOString(),
      hub_name: this.cfg.hub_name,
      request_id,
      user_oidc_sub: userOidcSub,
      local_username: identity.username,
      share,
      tool,
      outcome,
      error: errorMsg,
    });

    if (dispatchResult.error) {
      return { request_id, error: dispatchResult.error };
    }
    return { request_id, result: dispatchResult.result };
  }

  /** Logs, audits, and builds the error response for a denied permission check on the given share. */
  private permissionDenied(
    request_id: string,
    tool: string,
    share: string,
    userOidcSub: string | null,
    username: string,
    reason: string
  ): object {
    this.log.info({ request_id, tool, share, username, reason }, "Permission denied");
    this.audit.write({
      ts: new Date().toISOString(),
      hub_name: this.cfg.hub_name,
      request_id,
      user_oidc_sub: userOidcSub,
      local_username: username,
      share,
      tool,
      outcome: "permission_denied",
      error: reason,
    });
    return { request_id, error: { message: reason } };
  }

  /** Graceful shutdown: stop reconnecting/closes the socket, then drain in-flight RPCs. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.log.info("Shutting down — draining in-flight RPCs (up to 30s)");
    await this.stop();

    await this.pool.shutdown(30_000);
    // Draining above only guarantees every audit entry was enqueued (write() doesn't
    // wait for the disk write itself) — flush so none are still in flight when this
    // process exits, then close its file handle.
    await this.audit.flush();
    await this.audit.close();
    this.log.info("Shutdown complete");
  }
}

// ---------------------------------------------------------------------------
// Hub daemon
// ---------------------------------------------------------------------------

export async function runHub(configPath: string): Promise<void> {
  if (process.platform !== "linux") {
    log.error("Hub is only supported on Linux");
    process.exit(1);
  }

  if (userInfo().uid === 0) {
    log.error("Hub must not run as root. Use a dedicated low-privilege service user with CAP_SETUID/CAP_SETGID.");
    process.exit(1);
  }

  // Load and validate config
  let cfg: HubConfig;
  try {
    cfg = loadHubConfig(configPath);
  } catch (err) {
    log.error({ err }, "Failed to load hub config");
    process.exit(1);
  }

  const validation = validateHubConfig(cfg);
  for (const w of validation.warnings) log.warn(w);
  if (!validation.ok) {
    for (const e of validation.errors) log.error(e);
    log.error("Config validation failed — refusing to start");
    process.exit(1);
  }

  // Source env file before reading the token
  if (cfg.env_file) {
    try {
      sourceEnvFile(cfg.env_file);
    } catch (err) {
      log.error({ err }, "Failed to source env_file");
      process.exit(1);
    }
  }

  const hubToken = process.env["CONSTELLATION_HUB_TOKEN"];
  if (!hubToken) {
    log.error("CONSTELLATION_HUB_TOKEN is not set. Set it in the environment or via env_file.");
    process.exit(1);
  }

  // Resolve share paths via realpath (config load-time)
  const shareRegistry: Record<string, string> = {};
  for (const share of cfg.shares) {
    const result = await checkSharePath(share.name, share.path);
    if (!result.ok) {
      log.error({ share: share.name, path: share.path }, result.error + " — skipping");
      continue;
    }
    shareRegistry[share.name] = result.resolved;
  }

  if (Object.keys(shareRegistry).length === 0) {
    log.warn("No share paths could be resolved — hub will start but cannot serve any shares");
  }

  const pool = new SubnodePool(cfg, shareRegistry);
  const socket = new HubSocket(cfg, hubToken, shareRegistry, pool);

  // Lives alongside the audit log — that directory is always present (audit_log is a
  // required field) and already writable by the service user, so no new systemd
  // ReadWritePaths grant is needed just for this. The rotated token itself is still
  // persisted to env_file's own directory (see HubSocket's token_rotated handler);
  // `hub install` grants write access there separately, only when env_file is set.
  const controlServer = startControlServer(dirname(cfg.audit_log), socket);

  const shutdown = () => {
    controlServer.close();
    socket.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  socket.start();
  log.info({ hubName: cfg.hub_name, shares: Object.keys(shareRegistry) }, "Hub started");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reverse-map absolute_root to share name when share field not in envelope */
function guessShare(absoluteRoot: string, registry: Record<string, string>): string {
  for (const [name, path] of Object.entries(registry)) {
    if (path === absoluteRoot) return name;
  }
  return "";
}

/**
 * Resolves the destination share name for cross-share copy/move permission checks.
 * Prefers the client-supplied dst_share; falls back to reverse-mapping dst_root the
 * same way guessShare() does for the source share. FileExecutor independently accepts
 * dst_root on its own (resolving it against its own share registry — see
 * packages/shared/src/executor/index.ts), so this check must recognize the same shape
 * or a destination reachable via dst_root alone would bypass the permission layer
 * entirely.
 */
export function resolveDstShare(
  envelope: RpcEnvelope,
  tool: string,
  registry: Record<string, string>
): string | null {
  if (tool !== "copy" && tool !== "move") return null;
  if (typeof envelope.params["dst_share"] === "string") return envelope.params["dst_share"];
  if (typeof envelope.params["dst_root"] === "string") return guessShare(envelope.params["dst_root"], registry) || null;
  return null;
}

function writeTokenToEnvFile(envFile: string, token: string): void {
  let existing: string[] = [];
  try {
    existing = readFileSync(envFile, "utf8").split("\n");
  } catch { /* file may not exist */ }

  const key = "CONSTELLATION_HUB_TOKEN";
  const updated = existing.filter((line) => !line.startsWith(`${key}=`) && line !== "");
  updated.push(`${key}=${token}`);
  writeFileSync(envFile, updated.join("\n") + "\n", { mode: 0o600 });
}
