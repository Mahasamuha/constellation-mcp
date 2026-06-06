import { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { AgentTokenType } from "./generated/prisma/client.js";
import { hashToken, generateToken, createLogger, type RpcError, type RpcResponse } from "@constellation/shared";
import { config } from "./config.js";

const log = createLogger("hub");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcEnvelope {
  request_id: string;
  tool: string;
  absolute_root: string;
  user_oidc_sub: string | null;
  user_claims: Record<string, unknown>;
  [key: string]: unknown;
}

interface ConfigUpdateMessage {
  type: "config_update";
  paths: unknown;
}

interface UpdateHostMessage {
  type: "update_host";
  host: unknown;
}

interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  userId: string | null;
  tokenType: AgentTokenType;
  host: string;
  tokenId: string;
  lastPongAt: number;
  missedPings: number;
  disconnectReason?: "clean" | "timeout" | "error";
}

interface PendingRotationEntry {
  agentId: string;
  oldTokenId: string;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Primary connection map: agentId → connected agent state */
const connections = new Map<string, ConnectedAgent>();

/** Reverse lookup: tokenId → agentId (for reconnect rate limiting) */
const tokenIndex = new Map<string, string>();

/** Pending token rotations: newTokenId → entry. Cleared on reconnect or TTL expiry. */
const pendingRotations = new Map<string, PendingRotationEntry>();

const ROTATION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limiter — sliding window per agent token
// ---------------------------------------------------------------------------

const reconnectTimestamps = new Map<string, number[]>();

function checkReconnectRateLimit(tokenId: string): boolean {
  const limit = config.rateLimits.wsReconnectPerMin;
  const now = Date.now();
  const window = 60_000;
  const timestamps = (reconnectTimestamps.get(tokenId) ?? []).filter((t) => now - t < window);
  timestamps.push(now);
  reconnectTimestamps.set(tokenId, timestamps);
  return timestamps.length <= limit;
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = config.heartbeat.intervalMs;
const HEARTBEAT_MAX_MISSED = config.heartbeat.maxMissed;
const WS_MAX_MESSAGE_BYTES = config.ws.maxMessageBytes;
const RPC_TIMEOUT_MS = config.rpcTimeoutMs;

let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startHeartbeatLoop(): void {
  _heartbeatInterval = setInterval(() => {
    for (const [agentId, conn] of connections) {
      conn.missedPings += 1;

      if (conn.missedPings > HEARTBEAT_MAX_MISSED) {
        log.warn({ agentId, lastPongAt: new Date(conn.lastPongAt) }, "Agent heartbeat timeout — terminating");
        conn.disconnectReason = "timeout";
        conn.ws.terminate();
        connections.delete(agentId);
        tokenIndex.delete(conn.tokenId);
        rejectAgentRpcs(agentId);
        continue;
      }

      conn.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// WebSocket server setup
// ---------------------------------------------------------------------------

let _wss: WebSocketServer | null = null;

export function closeHub(): Promise<void> {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
  return new Promise((resolve, reject) => {
    if (!_wss) { resolve(); return; }
    _wss.close((err) => err ? reject(err) : resolve());
  });
}

export function attachHub(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  _wss = wss;

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    if (req.url !== "/agent/connect") {
      socket.destroy();
      return;
    }

    const authHeader = req.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = authHeader.slice(7);
    const tokenHash = hashToken(token);

    const agentToken = await prisma.agentToken.findUnique({
      where: { tokenHash },
      include: {
        agents: { select: { id: true, userId: true, host: true } },
      },
    });

    if (!agentToken || agentToken.revokedAt !== null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Primary lookup: find the agent that currently references this token.
    // For a pending rotation token, agentTokenId hasn't been updated yet — fall
    // back to the pendingRotations map.
    let agent = agentToken.agents[0];
    let pendingRotation: PendingRotationEntry | undefined;

    if (!agent) {
      pendingRotation = pendingRotations.get(agentToken.id);
      if (!pendingRotation) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const agentRecord = await prisma.agent.findUnique({
        where: { id: pendingRotation.agentId },
        select: { id: true, userId: true, host: true },
      });
      if (!agentRecord) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      agent = agentRecord;
    }

    if (!checkReconnectRateLimit(agentToken.id)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    // Update last_used_at on the token.
    await prisma.agentToken.update({
      where: { id: agentToken.id },
      data: { lastUsedAt: new Date() },
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, {
        agentId: agent.id,
        userId: agent.userId,
        tokenType: agentToken.tokenType,
        host: agent.host,
        tokenId: agentToken.id,
        pendingRotation,
      });
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, meta: {
    agentId: string;
    userId: string | null;
    tokenType: AgentTokenType;
    host: string;
    tokenId: string;
    pendingRotation?: PendingRotationEntry;
  }) => {
    void handleConnection(ws, meta);
  });

  startHeartbeatLoop();
}

async function handleConnection(ws: WebSocket, meta: {
  agentId: string;
  userId: string | null;
  tokenType: AgentTokenType;
  host: string;
  tokenId: string;
  pendingRotation?: PendingRotationEntry;
}): Promise<void> {
    const { agentId, userId, tokenType, host, tokenId, pendingRotation } = meta;

    // Complete a pending token rotation: atomically update agentTokenId and revoke the old token,
    // then cancel the expiry timer.
    // Guard against concurrent reconnects with the same new token: only the first handleConnection
    // to run (before any await) will find the entry still in the map and proceed; the second
    // treats the connection as a normal reconnect since rotation is already done.
    if (pendingRotation && pendingRotations.has(tokenId)) {
      clearTimeout(pendingRotation.timer);
      pendingRotations.delete(tokenId);
      try {
        await prisma.$transaction([
          prisma.agent.update({ where: { id: agentId }, data: { agentTokenId: tokenId } }),
          prisma.agentToken.update({ where: { id: pendingRotation.oldTokenId }, data: { revokedAt: new Date() } }),
        ]);
      } catch (err) {
        log.error({ err, agentId }, "Failed to complete token rotation — closing connection");
        ws.close(1011, "Internal error during token rotation");
        return;
      }
      log.info({ agentId, host }, "Token rotation completed");
    }

    // Handle duplicate connections — terminate the old one.
    const existing = connections.get(agentId);
    if (existing) {
      log.info({ agentId, host }, "Replacing stale agent connection");
      existing.ws.terminate();
    }

    const conn: ConnectedAgent = {
      ws,
      agentId,
      userId,
      tokenType,
      host,
      tokenId,
      lastPongAt: Date.now(),
      missedPings: 0,
    };

    connections.set(agentId, conn);
    tokenIndex.set(tokenId, agentId);

    // Record connection time immediately so list_hosts shows the agent as online
    // before the first heartbeat pong arrives (up to HEARTBEAT_INTERVAL_MS away).
    prisma.agent.update({
      where: { id: agentId },
      data: { lastHeartbeatAt: new Date() },
    }).catch((err) => log.error({ err, agentId }, "Failed to set initial lastHeartbeatAt"));

    log.info({ agentId, host, userId }, "Agent connected");

    ws.on("pong", () => {
      conn.lastPongAt = Date.now();
      conn.missedPings = 0;
      prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: new Date() },
      }).catch((err) => log.error({ err, agentId }, "Failed to update last_heartbeat_at"));
    });

    ws.on("message", (data) => {
      const byteLength = Buffer.isBuffer(data)
        ? data.length
        : Array.isArray(data)
          ? data.reduce((sum, b) => sum + b.length, 0)
          : data.byteLength;
      if (byteLength > WS_MAX_MESSAGE_BYTES) {
        log.warn({ agentId, size: byteLength, limit: WS_MAX_MESSAGE_BYTES }, "Agent message exceeds size limit — terminating");
        conn.disconnectReason = "error";
        ws.terminate();
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log.warn({ agentId }, "Received non-JSON message from agent");
        return;
      }
      handleAgentMessage(conn, msg).catch((err) => {
        log.error({ err, agentId }, "Error handling agent message");
        // Best-effort: send a typed error back so the agent doesn't wait indefinitely.
        const type = typeof msg["type"] === "string" ? msg["type"] : undefined;
        if (type === "config_update") send(conn.ws, { type: "config_update_error", error: "Internal error" });
        else if (type === "update_host") send(conn.ws, { type: "update_host_error", error: "Internal error" });
      });
    });

    ws.on("close", () => {
      const reason = conn.disconnectReason ?? "clean";
      // Guard against the race where a reconnecting agent registers a new connection
      // before this close event fires — avoid clobbering the live entry.
      if (connections.get(agentId) === conn) {
        connections.delete(agentId);
        tokenIndex.delete(tokenId);
        rejectAgentRpcs(agentId);
        prisma.agent.update({
          where: { id: agentId },
          data: { lastHeartbeatAt: null, lastDisconnectReason: reason },
        }).catch((err) => log.error({ err, agentId }, "Failed to update disconnect state"));
        log.info({ agentId, host, userId, reason }, "Agent disconnected");
      }
    });

    ws.on("error", (err) => {
      conn.disconnectReason = "error";
      log.error({ err, agentId }, "Agent WebSocket error");
    });
}

// ---------------------------------------------------------------------------
// Inbound message handlers
// ---------------------------------------------------------------------------

async function handleAgentMessage(
  conn: ConnectedAgent,
  msg: Record<string, unknown>
): Promise<void> {
  // RPC responses carry request_id with result or error but no type field.
  if ("request_id" in msg && ("result" in msg || "error" in msg)) {
    routeRpcResponse(msg as unknown as RpcResponse);
    return;
  }

  const type = msg["type"];

  if (type === "config_update") {
    await handleConfigUpdate(conn, msg as unknown as ConfigUpdateMessage);
  } else if (type === "update_host") {
    await handleUpdateHost(conn, msg as unknown as UpdateHostMessage);
  } else if (type === "rotate_token") {
    await handleRotateToken(conn);
  } else if (type === "shared_label_sync") {
    await handleSharedLabelSync(conn, msg as unknown as SharedLabelSyncMessage);
  } else {
    log.warn({ agentId: conn.agentId, type }, "Unknown control message from agent — dropping");
  }
}

interface ConfigUpdateEntry {
  label: string;
  reported_path: string;
}

async function handleConfigUpdate(conn: ConnectedAgent, msg: ConfigUpdateMessage): Promise<void> {
  if (conn.tokenType === AgentTokenType.SHARED) {
    send(conn.ws, { type: "config_update_error", error: "Shared agents use admin-defined labels; config_update is not supported" });
    return;
  }
  // After SHARED guard: userId is guaranteed non-null for PERSONAL connections.
  const userId = conn.userId!;
  const paths = msg.paths;
  if (!Array.isArray(paths)) {
    send(conn.ws, { type: "config_update_error", error: "paths must be an array" });
    return;
  }

  const entries = paths as ConfigUpdateEntry[];

  // Validate all labels before writing anything.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.label || !entry.reported_path) {
      send(conn.ws, { type: "config_update_error", error: "Each path entry must have label and reported_path" });
      return;
    }
    if (seen.has(entry.label)) {
      send(conn.ws, { type: "config_update_error", error: `Duplicate label in payload: ${entry.label}` });
      return;
    }
    seen.add(entry.label);
  }

  // Upsert all provided labels and remove any that are no longer present.
  // Conflict check is inside the transaction to avoid a TOCTOU race where two
  // agents register the same label concurrently and both pass a pre-transaction check.
  // Throwing inside the transaction rolls it back cleanly.
  class LabelConflictError extends Error {
    constructor(public readonly label: string) { super(); }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        const conflict = await tx.pathLabel.findFirst({
          where: {
            userId,
            label: entry.label,
            NOT: { agentId: conn.agentId },
          },
        });
        if (conflict) throw new LabelConflictError(entry.label);
      }

      for (const entry of entries) {
        await tx.pathLabel.upsert({
          where: { userId_label: { userId, label: entry.label } },
          create: {
            userId,
            agentId: conn.agentId,
            label: entry.label,
            reportedPath: entry.reported_path,
          },
          update: { reportedPath: entry.reported_path },
        });
      }

      // Remove labels belonging to this agent that are no longer in the payload.
      const activeLabels = entries.map((e) => e.label);
      await tx.pathLabel.deleteMany({
        where: {
          agentId: conn.agentId,
          label: { notIn: activeLabels },
        },
      });
    });
  } catch (err) {
    if (err instanceof LabelConflictError) {
      send(conn.ws, {
        type: "config_update_error",
        error: `Label "${err.label}" is already registered by another agent`,
      });
      return;
    }
    throw err;
  }

  log.info({ agentId: conn.agentId, count: entries.length }, "Config updated");
  send(conn.ws, { type: "config_update_ok" });
}

async function handleUpdateHost(conn: ConnectedAgent, msg: UpdateHostMessage): Promise<void> {
  if (conn.tokenType === AgentTokenType.SHARED) {
    send(conn.ws, { type: "update_host_error", error: "Shared agents use a fixed host (machine ID); update_host is not supported" });
    return;
  }
  // After SHARED guard: userId is guaranteed non-null for PERSONAL connections.
  const userId = conn.userId!;
  const newHost = typeof msg.host === "string" ? msg.host.trim() : "";

  if (!newHost) {
    send(conn.ws, { type: "update_host_error", error: "host must be a non-empty string" });
    return;
  }

  if (newHost.length > 63) {
    send(conn.ws, { type: "update_host_error", error: "Host name must be 63 characters or fewer" });
    return;
  }

  const conflict = await prisma.agent.findFirst({
    where: { userId, host: newHost, NOT: { id: conn.agentId } },
  });

  if (conflict) {
    send(conn.ws, { type: "update_host_error", error: `Host name "${newHost}" is already registered` });
    return;
  }

  await prisma.agent.update({ where: { id: conn.agentId }, data: { host: newHost } });
  conn.host = newHost;

  log.info({ agentId: conn.agentId, newHost }, "Agent host updated");
  send(conn.ws, { type: "update_host_ok", host: newHost });
}

async function handleRotateToken(conn: ConnectedAgent): Promise<void> {
  const newToken = generateToken();
  const newTokenHash = hashToken(newToken);

  const newAgentToken = await prisma.agentToken.create({
    data: {
      userId: conn.userId,
      tokenType: conn.tokenType,
      tokenHash: newTokenHash,
      expiresAt: new Date(Date.now() + ROTATION_TTL_MS),
    },
    select: { id: true },
  });

  // Cancel any prior pending rotation for this agent to avoid orphaned tokens.
  for (const [priorTokenId, entry] of pendingRotations) {
    if (entry.agentId === conn.agentId) {
      clearTimeout(entry.timer);
      pendingRotations.delete(priorTokenId);
      prisma.agentToken.update({ where: { id: priorTokenId }, data: { revokedAt: new Date() } })
        .catch((err) => log.error({ err, priorTokenId }, "Failed to revoke superseded rotation token"));
      break;
    }
  }

  // Do NOT update agent.agentTokenId yet — the agent must reconnect with the new token first.
  // If it does not reconnect within the TTL, revoke the new token so the old one stays valid.
  const timer = setTimeout(() => {
    pendingRotations.delete(newAgentToken.id);
    prisma.agentToken.update({ where: { id: newAgentToken.id }, data: { revokedAt: new Date() } })
      .catch((err) => log.error({ err, agentId: conn.agentId }, "Failed to revoke expired rotation token"));
    log.warn({ agentId: conn.agentId }, "Rotation token expired unused — old token remains active");
  }, ROTATION_TTL_MS);

  pendingRotations.set(newAgentToken.id, {
    agentId: conn.agentId,
    oldTokenId: conn.tokenId,
    timer,
  });

  log.info({ agentId: conn.agentId }, "Token rotation prepared");
  send(conn.ws, { type: "token_rotated", token: newToken });
}

// ---------------------------------------------------------------------------
// Shared label sync
// ---------------------------------------------------------------------------

interface SharedLabelEntry {
  name: string;
  reported_path: string;
  permission_blob: object;
}

interface SharedLabelSyncMessage {
  type: "shared_label_sync";
  labels: unknown;
}

async function handleSharedLabelSync(conn: ConnectedAgent, msg: SharedLabelSyncMessage): Promise<void> {
  if (conn.tokenType !== AgentTokenType.SHARED) {
    send(conn.ws, { type: "shared_label_sync_error", error: "shared_label_sync is only valid for SHARED agent tokens" });
    return;
  }

  const rawLabels = msg.labels;
  if (!Array.isArray(rawLabels)) {
    send(conn.ws, { type: "shared_label_sync_error", error: "labels must be an array" });
    return;
  }

  const labels = rawLabels as SharedLabelEntry[];

  // Validate shape
  for (const entry of labels) {
    if (typeof entry.name !== "string" || !entry.name) {
      send(conn.ws, { type: "shared_label_sync_error", error: "Each label entry must have a name string" });
      return;
    }
    if (typeof entry.reported_path !== "string" || !entry.reported_path) {
      send(conn.ws, { type: "shared_label_sync_error", error: `Label '${entry.name}': reported_path must be a non-empty string` });
      return;
    }
    if (typeof entry.permission_blob !== "object" || entry.permission_blob === null) {
      send(conn.ws, { type: "shared_label_sync_error", error: `Label '${entry.name}': permission_blob must be an object` });
      return;
    }
  }

  // Upsert labels and remove stale entries in a transaction
  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of labels) {
        await tx.sharedPathLabel.upsert({
          where: { agentId_label: { agentId: conn.agentId, label: entry.name } },
          create: {
            agentId: conn.agentId,
            label: entry.name,
            reportedPath: entry.reported_path,
            permissionBlob: entry.permission_blob,
          },
          update: {
            reportedPath: entry.reported_path,
            permissionBlob: entry.permission_blob,
          },
        });
      }

      const activeLabels = labels.map((e) => e.name);
      await tx.sharedPathLabel.deleteMany({
        where: {
          agentId: conn.agentId,
          label: { notIn: activeLabels },
        },
      });
    });
  } catch (err) {
    log.error({ err, agentId: conn.agentId }, "Failed to sync shared labels");
    send(conn.ws, { type: "shared_label_sync_error", error: "Internal error during label sync" });
    return;
  }

  log.info({ agentId: conn.agentId, count: labels.length }, "Shared labels synced");
  send(conn.ws, { type: "shared_label_sync_ok" });
}

// ---------------------------------------------------------------------------
// RPC dispatch (used by the request router in section 5)
// ---------------------------------------------------------------------------

export type { RpcError };

const pendingRpcs = new Map<string, {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  agentId: string;
}>();

export function getConnection(agentId: string): ConnectedAgent | undefined {
  return connections.get(agentId);
}

/** Revokes AgentToken rows that are not referenced by any Agent, were never revoked, and have
 * passed their expiry. Handles tokens left behind by a broker restart mid-rotation. Fresh
 * rotation tokens (expiresAt in the future) are left intact so the agent can complete rotation.
 * Called at startup and on the periodic prune interval. */
export async function pruneExpiredOrphanedTokens(): Promise<void> {
  const result = await prisma.agentToken.updateMany({
    where: { revokedAt: null, agents: { none: {} }, expiresAt: { lt: new Date() } },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    log.warn({ count: result.count }, "Revoked orphaned agent tokens from prior restart");
  }
}

/** Removes expired reconnect timestamp entries. Called periodically from index.ts. */
export function pruneReconnectTimestamps(): void {
  const now = Date.now();
  const window = 60_000;
  for (const [k, ts] of reconnectTimestamps) {
    const fresh = ts.filter((t) => now - t < window);
    if (fresh.length === 0) reconnectTimestamps.delete(k);
    else reconnectTimestamps.set(k, fresh);
  }
}

/** Rejects all pending RPCs for a given agent — called on disconnect. */
export function rejectAgentRpcs(agentId: string): void {
  for (const [requestId, pending] of pendingRpcs) {
    if (pending.agentId === agentId) {
      clearTimeout(pending.timer);
      pendingRpcs.delete(requestId);
      pending.reject(new Error("agent_disconnected"));
    }
  }
}

export function dispatchRpc(
  agentId: string,
  payload: RpcEnvelope
): Promise<RpcResponse> {
  const conn = connections.get(agentId);
  if (!conn) throw new Error(`Agent ${agentId} is not connected`);

  const requestId = payload["request_id"] as string;
  const timeoutMs = RPC_TIMEOUT_MS;

  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(requestId);
      reject(new Error("timeout"));
    }, timeoutMs);

    pendingRpcs.set(requestId, { resolve, reject, timer, agentId });
    send(conn.ws, payload);
  });
}

function routeRpcResponse(msg: RpcResponse): void {
  const requestId = msg.request_id;
  if (!requestId) return;

  const pending = pendingRpcs.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRpcs.delete(requestId);
  pending.resolve(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
