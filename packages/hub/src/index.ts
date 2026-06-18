import { checkLabelPath } from "./paths.js";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { createLogger, MAX_LABEL_INSTRUCTIONS_LENGTH, RelaySocket, type RpcEnvelope } from "@constellation/shared";
import { loadHubConfig, validateHubConfig, type HubConfig } from "./config.js";
import { resolveIdentity, isIdentityError } from "./identity.js";
import { checkRpcPermission, buildPermissionBlob } from "./permissions.js";
import { writeAuditEntry } from "./audit.js";
import { SubnodePool, isDispatchError } from "./subnode.js";

const log = createLogger("hub");

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
// Label sync payload
// ---------------------------------------------------------------------------

function buildLabelSyncPayload(cfg: HubConfig, labelRegistry: Record<string, string>): object {
  return {
    type: "shared_label_sync",
    labels: cfg.labels
      .filter((l) => labelRegistry[l.name] !== undefined)
      .map((l) => {
        const entry: { name: string; reported_path: string; permission_blob: object; instructions?: string } = {
          name: l.name,
          reported_path: labelRegistry[l.name]!,
          permission_blob: buildPermissionBlob(l),
        };

        let instructions: string | undefined;
        if (l.instructions) {
          instructions = l.instructions;
        } else if (l.context_file) {
          try {
            instructions = readFileSync(l.context_file, "utf8");
          } catch {
            log.info({ label: l.name, context_file: l.context_file }, "context_file is set but could not be read — omitting instructions");
          }
        }

        if (instructions !== undefined) {
          if (instructions.length > MAX_LABEL_INSTRUCTIONS_LENGTH) {
            log.warn(
              { label: l.name, length: instructions.length, max: MAX_LABEL_INSTRUCTIONS_LENGTH },
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
 * the hub modality: label sync on connect, resolving each RPC to an OS
 * identity, permission checks, subnode dispatch, audit logging, and
 * graceful drain-on-shutdown.
 */
class HubSocket extends RelaySocket {
  private shuttingDown = false;

  constructor(
    private readonly cfg: HubConfig,
    private readonly hubToken: string,
    private readonly labelRegistry: Record<string, string>,
    private readonly pool: SubnodePool
  ) {
    super({ logModule: "hub", path: "/executor/connect" });
  }

  protected getRelayUrl(): string {
    return this.cfg.relay_url;
  }

  protected getToken(): string {
    return this.hubToken;
  }

  protected onOpen(): void {
    this.log.info({ hubName: this.cfg.hub_name }, "Connected to relay");
    this.send(buildLabelSyncPayload(this.cfg, this.labelRegistry));
  }

  protected onMessage(msg: Record<string, unknown>): void {
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      if (this.shuttingDown) {
        this.send({ request_id: msg["request_id"], error: { message: "HUB_SHUTTING_DOWN — retry after 45 seconds" } });
        return;
      }
      this.handleRpc(msg as RpcEnvelope)
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
        return;
      }
      // Write the new token to the env file
      if (this.cfg.env_file) {
        try {
          writeTokenToEnvFile(this.cfg.env_file, token);
          this.log.info("Rotated token written to env_file. Restart the hub to reconnect.");
        } catch (err) {
          this.log.error({ err }, "Failed to write rotated token to env_file");
        }
      } else {
        this.log.warn("Token rotated but no env_file configured — new token not persisted. Restart hub manually with the new token.");
      }
      this.ws?.close();
      return;
    }

    if (type === "shared_label_sync_ok") {
      this.log.info("Relay acknowledged label sync");
      return;
    }

    if (type === "shared_label_sync_error") {
      this.log.warn({ error: msg["error"] }, "Relay returned error for label sync");
      return;
    }

    if (type === "config_update_ok" || type === "config_update_error") {
      // Expected rejection for hubs; ignore
      return;
    }

    this.log.warn({ type }, "Unknown message from relay — dropping");
  }

  private async handleRpc(envelope: RpcEnvelope): Promise<object> {
    const { request_id, tool } = envelope;
    const userOidcSub = typeof envelope["user_oidc_sub"] === "string" ? envelope["user_oidc_sub"] : null;
    const userClaims = (envelope["user_claims"] !== null && typeof envelope["user_claims"] === "object"
      ? envelope["user_claims"]
      : {}) as Record<string, unknown>;
    const label = typeof envelope["label"] === "string" ? envelope["label"] : guessLabel(envelope.absolute_root, this.labelRegistry);

    // Resolve OS identity
    const identity = await resolveIdentity(userClaims, userOidcSub, this.cfg.identity);

    if (isIdentityError(identity)) {
      this.log.warn({ request_id, tool, label, error: identity.message }, "Identity resolution failed");
      writeAuditEntry(this.cfg.audit_log, {
        ts: new Date().toISOString(),
        hub_name: this.cfg.hub_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: null,
        label,
        tool,
        outcome: "identity_error",
        error: identity.message,
      });
      return { request_id, error: { message: identity.message } };
    }

    // Check permissions — for cross-label copy/move, dst_label is checked too.
    const dstLabel = (tool === "copy" || tool === "move") && typeof envelope["dst_label"] === "string"
      ? envelope["dst_label"]
      : null;
    const permission = checkRpcPermission(userOidcSub, label, dstLabel, tool, this.cfg.labels);
    if (!permission.permitted) {
      return this.permissionDenied(request_id, tool, permission.label, userOidcSub, identity.username, permission.reason);
    }

    // Build tool params from the envelope, excluding all relay-routing fields.
    // Named exclusion keeps this explicit — new routing fields must be listed here.
    const ROUTING_FIELDS = new Set(["request_id", "tool", "absolute_root", "user_oidc_sub", "user_claims", "label"]);
    const params: Record<string, unknown> = Object.fromEntries(
      Object.entries(envelope).filter(([k]) => !ROUTING_FIELDS.has(k))
    );

    // Dispatch to subnode
    const dispatchResult = await this.pool.dispatch(identity, tool, label, params, request_id);

    if (isDispatchError(dispatchResult)) {
      this.log.warn({ request_id, tool, label, username: identity.username, error: dispatchResult.message }, "Subnode dispatch failed");
      writeAuditEntry(this.cfg.audit_log, {
        ts: new Date().toISOString(),
        hub_name: this.cfg.hub_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: identity.username,
        label,
        tool,
        outcome: "exec_error",
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

    writeAuditEntry(this.cfg.audit_log, {
      ts: new Date().toISOString(),
      hub_name: this.cfg.hub_name,
      request_id,
      user_oidc_sub: userOidcSub,
      local_username: identity.username,
      label,
      tool,
      outcome,
      error: errorMsg,
    });

    if (dispatchResult.error) {
      return { request_id, error: dispatchResult.error };
    }
    return { request_id, result: dispatchResult.result };
  }

  /** Logs, audits, and builds the error response for a denied permission check on the given label. */
  private permissionDenied(
    request_id: string,
    tool: string,
    label: string,
    userOidcSub: string | null,
    username: string,
    reason: string
  ): object {
    this.log.info({ request_id, tool, label, username, reason }, "Permission denied");
    writeAuditEntry(this.cfg.audit_log, {
      ts: new Date().toISOString(),
      hub_name: this.cfg.hub_name,
      request_id,
      user_oidc_sub: userOidcSub,
      local_username: username,
      label,
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
    this.stop();

    await this.pool.shutdown(30_000);
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

  // Resolve label paths via realpath (config load-time)
  const labelRegistry: Record<string, string> = {};
  for (const label of cfg.labels) {
    const result = await checkLabelPath(label.name, label.path);
    if (!result.ok) {
      log.error({ label: label.name, path: label.path }, result.error + " — skipping");
      continue;
    }
    labelRegistry[label.name] = result.resolved;
  }

  if (Object.keys(labelRegistry).length === 0) {
    log.warn("No label paths could be resolved — hub will start but cannot serve any labels");
  }

  const pool = new SubnodePool(cfg, labelRegistry);
  const socket = new HubSocket(cfg, hubToken, labelRegistry, pool);

  process.on("SIGTERM", () => {
    socket.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    socket.shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  socket.start();
  log.info({ hubName: cfg.hub_name, labels: Object.keys(labelRegistry) }, "Hub started");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reverse-map absolute_root to label name when label field not in envelope */
function guessLabel(absoluteRoot: string, registry: Record<string, string>): string {
  for (const [name, path] of Object.entries(registry)) {
    if (path === absoluteRoot) return name;
  }
  return "";
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
