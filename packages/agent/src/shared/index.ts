import WebSocket from "ws";
import { promises as fs } from "node:fs";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { createLogger } from "@constellation/shared";
import { loadSharedConfig, validateSharedConfig, type SharedAgentConfig } from "./config.js";
import { resolveIdentity, isIdentityError } from "./identity.js";
import { checkPermission, buildPermissionBlob } from "./permissions.js";
import { writeAuditEntry } from "./audit.js";
import { SubagentPool, isDispatchError } from "./subagent.js";
import type { RpcEnvelope } from "../rpc.js";

const log = createLogger("agent:shared");

const INITIAL_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const JITTER_FACTOR = 0.2;
const MAX_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Env file sourcing
// ---------------------------------------------------------------------------

function sourceEnvFile(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read env_file '${path}': ${(err as Error).message}`);
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

function buildLabelSyncPayload(cfg: SharedAgentConfig, labelRegistry: Record<string, string>): object {
  return {
    type: "shared_label_sync",
    labels: cfg.labels
      .filter((l) => labelRegistry[l.name] !== undefined)
      .map((l) => ({
        name: l.name,
        reported_path: labelRegistry[l.name]!,
        permission_blob: buildPermissionBlob(l),
      })),
  };
}

// ---------------------------------------------------------------------------
// Shared agent daemon
// ---------------------------------------------------------------------------

export async function runSharedAgent(configPath: string): Promise<void> {
  if (process.platform !== "linux") {
    log.error("Shared agent is only supported on Linux");
    process.exit(1);
  }

  if (process.getuid!() === 0) {
    log.error("Shared agent must not run as root. Use a dedicated low-privilege service user with CAP_SETUID/CAP_SETGID.");
    process.exit(1);
  }

  // Load and validate config
  let cfg: SharedAgentConfig;
  try {
    cfg = loadSharedConfig(configPath);
  } catch (err) {
    log.error({ err }, "Failed to load shared agent config");
    process.exit(1);
  }

  const validation = validateSharedConfig(cfg);
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

  const agentToken = process.env["CONSTELLATION_AGENT_TOKEN"];
  if (!agentToken) {
    log.error("CONSTELLATION_AGENT_TOKEN is not set. Set it in the environment or via env_file.");
    process.exit(1);
  }

  // Resolve label paths via realpath (config load-time)
  const labelRegistry: Record<string, string> = {};
  for (const label of cfg.labels) {
    try {
      labelRegistry[label.name] = await fs.realpath(label.path);
    } catch {
      log.warn({ label: label.name, path: label.path }, "Label path does not exist or cannot be resolved — skipping");
    }
  }

  if (Object.keys(labelRegistry).length === 0) {
    log.warn("No label paths could be resolved — agent will start but cannot serve any labels");
  }

  const pool = new SubagentPool(cfg, labelRegistry);
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = INITIAL_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Track in-flight RPCs for graceful shutdown
  let inFlightRpcs = 0;

  function clearPingTimers(): void {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (pingTimeoutTimer) { clearTimeout(pingTimeoutTimer); pingTimeoutTimer = null; }
  }

  function send(msg: object): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const jitter = (Math.random() * 2 - 1) * JITTER_FACTOR * delay;
    const next = Math.min(delay + jitter, MAX_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, next);
    delay = Math.min(delay * BACKOFF_MULTIPLIER, MAX_DELAY_MS);
  }

  function connect(): void {
    if (stopped) return;

    const wsUrl = cfg.broker_url.replace(/^http/, "ws");

    if (wsUrl.startsWith("ws://")) {
      const host = new URL(wsUrl).hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!isLocal) {
        log.error({ url: wsUrl }, "Refusing to connect: broker URL uses ws:// for a non-localhost host. Use wss://");
        scheduleReconnect();
        return;
      }
    }

    log.info({ url: wsUrl }, "Connecting to broker");

    const sock = new WebSocket(wsUrl + "/agent/connect", {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    ws = sock;

    sock.on("open", () => {
      log.info({ agentName: cfg.agent_name }, "Connected to broker");
      delay = INITIAL_DELAY_MS;

      // Sync label registry on connect
      send(buildLabelSyncPayload(cfg, labelRegistry));

      pingInterval = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.ping();
        pingTimeoutTimer = setTimeout(() => {
          log.warn("Ping timeout — terminating connection");
          sock.terminate();
        }, PING_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    });

    sock.on("pong", () => {
      if (pingTimeoutTimer) { clearTimeout(pingTimeoutTimer); pingTimeoutTimer = null; }
    });

    sock.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log.warn("Received non-JSON message from broker");
        return;
      }
      handleMessage(msg);
    });

    sock.on("close", (code, reason) => {
      log.info({ code, reason: reason.toString() }, "Disconnected from broker");
      clearPingTimers();
      ws = null;
      scheduleReconnect();
    });

    sock.on("error", (err) => {
      log.error({ err }, "WebSocket error");
    });
  }

  function handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg["request_id"] === "string" && typeof msg["tool"] === "string") {
      if (stopped) {
        send({ request_id: msg["request_id"], error: { message: "AGENT_SHUTTING_DOWN — retry after 45 seconds" } });
        return;
      }
      inFlightRpcs++;
      handleRpc(msg as RpcEnvelope)
        .then((response) => send(response))
        .catch((err) => {
          log.error({ err }, "Unhandled error in RPC handler");
          send({ request_id: msg["request_id"], error: { message: "Internal agent error" } });
        })
        .finally(() => { inFlightRpcs--; });
      return;
    }

    const type = msg["type"];

    if (type === "token_rotated") {
      const token = msg["token"];
      if (typeof token !== "string") {
        log.warn("Received token_rotated without a token string");
        return;
      }
      // Write the new token to the env file
      if (cfg.env_file) {
        try {
          writeTokenToEnvFile(cfg.env_file, token);
          log.info("Rotated token written to env_file. Restart the agent to reconnect.");
        } catch (err) {
          log.error({ err }, "Failed to write rotated token to env_file");
        }
      } else {
        log.warn("Token rotated but no env_file configured — new token not persisted. Restart agent manually with the new token.");
      }
      ws?.close();
      return;
    }

    if (type === "shared_label_sync_ok") {
      log.info("Broker acknowledged label sync");
      return;
    }

    if (type === "shared_label_sync_error") {
      log.warn({ error: msg["error"] }, "Broker returned error for label sync");
      return;
    }

    if (type === "config_update_ok" || type === "config_update_error") {
      // Expected rejection for shared agents; ignore
      return;
    }

    log.warn({ type }, "Unknown message from broker — dropping");
  }

  async function handleRpc(envelope: RpcEnvelope): Promise<object> {
    const { request_id, tool } = envelope;
    const userOidcSub = typeof envelope["user_oidc_sub"] === "string" ? envelope["user_oidc_sub"] : null;
    const userClaims = (envelope["user_claims"] !== null && typeof envelope["user_claims"] === "object"
      ? envelope["user_claims"]
      : {}) as Record<string, unknown>;
    const label = typeof envelope["label"] === "string" ? envelope["label"] : guessLabel(envelope.absolute_root, labelRegistry);

    // Resolve OS identity
    const identity = resolveIdentity(userClaims, userOidcSub, cfg.identity);

    if (isIdentityError(identity)) {
      log.warn({ request_id, tool, label, error: identity.message }, "Identity resolution failed");
      writeAuditEntry(cfg.audit_log, {
        ts: new Date().toISOString(),
        agent_name: cfg.agent_name,
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

    // Check permissions
    const permission = checkPermission(userOidcSub, label, tool, cfg.labels);
    if (!permission.permitted) {
      log.info({ request_id, tool, label, username: identity.username, reason: permission.reason }, "Permission denied");
      writeAuditEntry(cfg.audit_log, {
        ts: new Date().toISOString(),
        agent_name: cfg.agent_name,
        request_id,
        user_oidc_sub: userOidcSub,
        local_username: identity.username,
        label,
        tool,
        outcome: "permission_denied",
        error: permission.reason,
      });
      return { request_id, error: { message: permission.reason } };
    }

    // Build the subagent params (everything except broker-routing fields)
    const params: Record<string, unknown> = { ...envelope };
    delete params["request_id"];
    delete params["tool"];
    delete params["absolute_root"];
    delete params["user_oidc_sub"];
    delete params["user_claims"];
    delete params["label"];

    // Dispatch to subagent
    const dispatchResult = await pool.dispatch(identity, tool, label, params, request_id);

    if (isDispatchError(dispatchResult)) {
      log.warn({ request_id, tool, label, username: identity.username, error: dispatchResult.message }, "Subagent dispatch failed");
      writeAuditEntry(cfg.audit_log, {
        ts: new Date().toISOString(),
        agent_name: cfg.agent_name,
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

    writeAuditEntry(cfg.audit_log, {
      ts: new Date().toISOString(),
      agent_name: cfg.agent_name,
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

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;

    log.info("Shutting down — draining in-flight RPCs (up to 30s)");

    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearPingTimers();
    ws?.close();
    ws = null;

    await pool.shutdown(30_000);
    log.info("Shutdown complete");
  }

  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  connect();
  log.info({ agentName: cfg.agent_name, labels: Object.keys(labelRegistry) }, "Shared agent started");
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

  const key = "CONSTELLATION_AGENT_TOKEN";
  const updated = existing.filter((line) => !line.startsWith(`${key}=`) && line !== "");
  updated.push(`${key}=${token}`);
  writeFileSync(envFile, updated.join("\n") + "\n", { mode: 0o600 });
}
