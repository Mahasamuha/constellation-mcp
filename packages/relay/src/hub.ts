import { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { ExecutorTokenType } from "./generated/prisma/client.js";
import { logEvent } from "./activity.js";
import { hashToken, generateToken, createLogger, type RpcError, type RpcResponse, type RpcEnvelope as BaseRpcEnvelope } from "@constellation/shared";
import { config } from "./config.js";
import {
  type ConnectedExecutor,
  registerConnection,
  unregisterConnection,
  getConnection,
  allConnections,
  dispatchPendingRpc,
  resolvePendingRpc,
  rejectPendingRpcsForExecutor,
} from "./registry.js";

const log = createLogger("hub");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Relay's view of the envelope adds the caller identity fields it forwards to
 * executors — node ignores them, hub uses them for OS-identity resolution. */
export interface RpcEnvelope extends BaseRpcEnvelope {
  user_oidc_sub: string | null;
  user_claims: Record<string, unknown>;
}

interface ConfigUpdateMessage {
  type: "config_update";
  paths: unknown;
}

interface UpdateHostMessage {
  type: "update_host";
  host: unknown;
}

interface PendingRotationEntry {
  executorId: string;
  oldTokenId: string;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Pending token rotations: newTokenId → entry. Cleared on reconnect or TTL expiry. */
const pendingRotations = new Map<string, PendingRotationEntry>();

const ROTATION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rate limiter — sliding window per executor token
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
    for (const [executorId, conn] of allConnections()) {
      conn.missedPings += 1;

      if (conn.missedPings > HEARTBEAT_MAX_MISSED) {
        log.warn({ executorId, lastPongAt: new Date(conn.lastPongAt) }, "Executor heartbeat timeout — terminating");
        conn.disconnectReason = "timeout";
        conn.ws.terminate();
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
    if (req.url !== "/executor/connect") {
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

    const executorToken = await prisma.executorToken.findUnique({
      where: { tokenHash },
      include: {
        executors: { select: { id: true, userId: true, host: true } },
      },
    });

    if (!executorToken || executorToken.revokedAt !== null || (executorToken.expiresAt !== null && executorToken.expiresAt < new Date())) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Primary lookup: find the executor that currently references this token.
    // For a pending rotation token, executorTokenId hasn't been updated yet — fall
    // back to the pendingRotations map.
    let executor = executorToken.executors[0];
    let pendingRotation: PendingRotationEntry | undefined;

    if (!executor) {
      pendingRotation = pendingRotations.get(executorToken.id);
      if (!pendingRotation) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const executorRecord = await prisma.executor.findUnique({
        where: { id: pendingRotation.executorId },
        select: { id: true, userId: true, host: true },
      });
      if (!executorRecord) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      executor = executorRecord;
    }

    if (!checkReconnectRateLimit(executorToken.id)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    // Update last_used_at on the token.
    await prisma.executorToken.update({
      where: { id: executorToken.id },
      data: { lastUsedAt: new Date() },
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, {
        executorId: executor.id,
        userId: executor.userId,
        tokenType: executorToken.tokenType,
        host: executor.host,
        tokenId: executorToken.id,
        pendingRotation,
      });
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, meta: {
    executorId: string;
    userId: string | null;
    tokenType: ExecutorTokenType;
    host: string;
    tokenId: string;
    pendingRotation?: PendingRotationEntry;
  }) => {
    void handleConnection(ws, meta);
  });

  startHeartbeatLoop();
}

async function handleConnection(ws: WebSocket, meta: {
  executorId: string;
  userId: string | null;
  tokenType: ExecutorTokenType;
  host: string;
  tokenId: string;
  pendingRotation?: PendingRotationEntry;
}): Promise<void> {
    const { executorId, userId, tokenType, host, tokenId, pendingRotation } = meta;

    // Complete a pending token rotation: atomically update executorTokenId and revoke the old token,
    // then cancel the expiry timer.
    // Guard against concurrent reconnects with the same new token: only the first handleConnection
    // to run (before any await) will find the entry still in the map and proceed; the second
    // treats the connection as a normal reconnect since rotation is already done.
    if (pendingRotation && pendingRotations.has(tokenId)) {
      clearTimeout(pendingRotation.timer);
      pendingRotations.delete(tokenId);
      try {
        await prisma.$transaction([
          prisma.executor.update({ where: { id: executorId }, data: { executorTokenId: tokenId } }),
          prisma.executorToken.update({ where: { id: pendingRotation.oldTokenId }, data: { revokedAt: new Date() } }),
        ]);
      } catch (err) {
        log.error({ err, executorId }, "Failed to complete token rotation — closing connection");
        ws.close(1011, "Internal error during token rotation");
        return;
      }
      log.info({ executorId, host }, "Token rotation completed");
    }

    const conn: ConnectedExecutor = {
      ws,
      executorId,
      userId,
      tokenType,
      host,
      tokenId,
      lastPongAt: Date.now(),
      missedPings: 0,
    };

    // Handle duplicate connections — terminate the old one.
    const existing = registerConnection(conn);
    if (existing) {
      log.info({ executorId, host }, "Replacing stale executor connection");
      existing.ws.terminate();
    }

    // Record connection time immediately so list_hosts shows the executor as online
    // before the first heartbeat pong arrives (up to HEARTBEAT_INTERVAL_MS away).
    // Also clear any stale disconnect reason from a prior session.
    prisma.executor.update({
      where: { id: executorId },
      data: { lastHeartbeatAt: new Date(), lastDisconnectReason: null },
    }).catch((err) => log.error({ err, executorId }, "Failed to set initial lastHeartbeatAt"));

    log.info({ executorId, host, userId }, "Executor connected");
    logEvent({ userId, eventType: "executor_connect", host });

    ws.on("pong", () => {
      conn.lastPongAt = Date.now();
      conn.missedPings = 0;
      prisma.executor.update({
        where: { id: executorId },
        data: { lastHeartbeatAt: new Date() },
      }).catch((err) => log.error({ err, executorId }, "Failed to update last_heartbeat_at"));
    });

    ws.on("message", (data) => {
      const byteLength = Buffer.isBuffer(data)
        ? data.length
        : Array.isArray(data)
          ? data.reduce((sum, b) => sum + b.length, 0)
          : data.byteLength;
      if (byteLength > WS_MAX_MESSAGE_BYTES) {
        log.warn({ executorId, size: byteLength, limit: WS_MAX_MESSAGE_BYTES }, "Executor message exceeds size limit — terminating");
        conn.disconnectReason = "error";
        ws.terminate();
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log.warn({ executorId }, "Received non-JSON message from executor");
        return;
      }
      handleExecutorMessage(conn, msg).catch((err) => {
        log.error({ err, executorId }, "Error handling executor message");
        // Best-effort: send a typed error back so the executor doesn't wait indefinitely.
        const type = typeof msg["type"] === "string" ? msg["type"] : undefined;
        if (type === "config_update") send(conn.ws, { type: "config_update_error", error: "Internal error" });
        else if (type === "update_host") send(conn.ws, { type: "update_host_error", error: "Internal error" });
        else if (type === "rotate_token") send(conn.ws, { type: "rotate_token_error", error: "Internal error" });
      });
    });

    ws.on("close", () => {
      const reason = conn.disconnectReason ?? "clean";
      // Guard against the race where a reconnecting executor registers a new connection
      // before this close event fires — avoid clobbering the live entry.
      if (unregisterConnection(conn)) {
        rejectExecutorRpcs(executorId);
        prisma.executor.update({
          where: { id: executorId },
          data: { lastHeartbeatAt: null, lastDisconnectReason: reason },
        }).catch((err) => log.error({ err, executorId }, "Failed to update disconnect state"));
        log.info({ executorId, host, userId, reason }, "Executor disconnected");
        logEvent({ userId, eventType: "executor_disconnect", host, errorCode: reason !== "clean" ? reason : undefined });
      }
    });

    ws.on("error", (err) => {
      conn.disconnectReason = "error";
      log.error({ err, executorId }, "Executor WebSocket error");
    });
}

// ---------------------------------------------------------------------------
// Inbound message handlers
// ---------------------------------------------------------------------------

async function handleExecutorMessage(
  conn: ConnectedExecutor,
  msg: Record<string, unknown>
): Promise<void> {
  // RPC responses carry request_id with result or error but no type field.
  if ("request_id" in msg && ("result" in msg || "error" in msg)) {
    routeRpcResponse(conn.executorId, msg as unknown as RpcResponse);
    return;
  }

  const type = msg["type"];

  if (type === "config_update") {
    await handleConfigUpdate(conn, msg as unknown as ConfigUpdateMessage);
  } else if (type === "update_host") {
    await handleUpdateHost(conn, msg as unknown as UpdateHostMessage);
  } else if (type === "rotate_token") {
    await handleRotateToken(conn);
  } else if (type === "hub_share_sync") {
    await handleHubShareSync(conn, msg as unknown as HubShareSyncMessage);
  } else {
    log.warn({ executorId: conn.executorId, type }, "Unknown control message from executor — dropping");
  }
}

interface ConfigUpdateEntry {
  share: string;
  reported_path: string;
  instructions?: string;
}

async function handleConfigUpdate(conn: ConnectedExecutor, msg: ConfigUpdateMessage): Promise<void> {
  if (conn.tokenType === ExecutorTokenType.HUB) {
    send(conn.ws, { type: "config_update_error", error: "Hubs use admin-defined shares; config_update is not supported" });
    return;
  }
  // After HUB guard: userId is guaranteed non-null for NODE connections.
  const userId = conn.userId!;
  const paths = msg.paths;
  if (!Array.isArray(paths)) {
    send(conn.ws, { type: "config_update_error", error: "paths must be an array" });
    return;
  }

  const entries = paths as ConfigUpdateEntry[];

  // Validate all shares before writing anything.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !entry.share || !entry.reported_path) {
      send(conn.ws, { type: "config_update_error", error: "Each path entry must have share and reported_path" });
      return;
    }
    if (seen.has(entry.share)) {
      send(conn.ws, { type: "config_update_error", error: `Duplicate share in payload: ${entry.share}` });
      return;
    }
    seen.add(entry.share);
  }

  // Upsert all provided shares and remove any that are no longer present.
  // Conflict check is inside the transaction to avoid a TOCTOU race where two
  // executors register the same share concurrently and both pass a pre-transaction check.
  // Throwing inside the transaction rolls it back cleanly.
  class ShareConflictError extends Error {
    constructor(public readonly share: string) { super(); }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        const conflict = await tx.pathShare.findFirst({
          where: {
            userId,
            share: entry.share,
            NOT: { executorId: conn.executorId },
          },
        });
        if (conflict) throw new ShareConflictError(entry.share);
      }

      for (const entry of entries) {
        const instructions = typeof entry.instructions === "string" ? entry.instructions : null;
        await tx.pathShare.upsert({
          where: { userId_share: { userId, share: entry.share } },
          create: {
            userId,
            executorId: conn.executorId,
            share: entry.share,
            reportedPath: entry.reported_path,
            instructions,
          },
          update: { reportedPath: entry.reported_path, instructions },
        });
      }

      // Remove shares belonging to this executor that are no longer in the payload.
      const activeShares = entries.map((e) => e.share);
      await tx.pathShare.deleteMany({
        where: {
          executorId: conn.executorId,
          share: { notIn: activeShares },
        },
      });
    });
  } catch (err) {
    if (err instanceof ShareConflictError) {
      send(conn.ws, {
        type: "config_update_error",
        error: `Share "${err.share}" is already registered by another executor`,
      });
      return;
    }
    throw err;
  }

  log.info({ executorId: conn.executorId, count: entries.length }, "Config updated");
  send(conn.ws, { type: "config_update_ok" });
}

async function handleUpdateHost(conn: ConnectedExecutor, msg: UpdateHostMessage): Promise<void> {
  if (conn.tokenType === ExecutorTokenType.HUB) {
    send(conn.ws, { type: "update_host_error", error: "Hubs use a fixed host (machine ID); update_host is not supported" });
    return;
  }
  // After HUB guard: userId is guaranteed non-null for NODE connections.
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

  const conflict = await prisma.executor.findFirst({
    where: { userId, host: newHost, NOT: { id: conn.executorId } },
  });

  if (conflict) {
    send(conn.ws, { type: "update_host_error", error: `Host name "${newHost}" is already registered` });
    return;
  }

  await prisma.executor.update({ where: { id: conn.executorId }, data: { host: newHost } });
  conn.host = newHost;

  log.info({ executorId: conn.executorId, newHost }, "Executor host updated");
  send(conn.ws, { type: "update_host_ok", host: newHost });
}

async function handleRotateToken(conn: ConnectedExecutor): Promise<void> {
  const newToken = generateToken();
  const newTokenHash = hashToken(newToken);

  const newExecutorToken = await prisma.executorToken.create({
    data: {
      userId: conn.userId,
      tokenType: conn.tokenType,
      tokenHash: newTokenHash,
      expiresAt: new Date(Date.now() + ROTATION_TTL_MS),
    },
    select: { id: true },
  });

  // Cancel any prior pending rotation for this executor to avoid orphaned tokens.
  for (const [priorTokenId, entry] of pendingRotations) {
    if (entry.executorId === conn.executorId) {
      clearTimeout(entry.timer);
      pendingRotations.delete(priorTokenId);
      prisma.executorToken.update({ where: { id: priorTokenId }, data: { revokedAt: new Date() } })
        .catch((err) => log.error({ err, priorTokenId }, "Failed to revoke superseded rotation token"));
      break;
    }
  }

  // Do NOT update executor.executorTokenId yet — the executor must reconnect with the new token first.
  // If it does not reconnect within the TTL, revoke the new token so the old one stays valid.
  const timer = setTimeout(() => {
    pendingRotations.delete(newExecutorToken.id);
    prisma.executorToken.update({ where: { id: newExecutorToken.id }, data: { revokedAt: new Date() } })
      .catch((err) => log.error({ err, executorId: conn.executorId }, "Failed to revoke expired rotation token"));
    log.warn({ executorId: conn.executorId }, "Rotation token expired unused — old token remains active");
  }, ROTATION_TTL_MS);

  pendingRotations.set(newExecutorToken.id, {
    executorId: conn.executorId,
    oldTokenId: conn.tokenId,
    timer,
  });

  log.info({ executorId: conn.executorId }, "Token rotation prepared");
  send(conn.ws, { type: "token_rotated", token: newToken });
}

// ---------------------------------------------------------------------------
// Hub share sync
// ---------------------------------------------------------------------------

interface HubShareEntry {
  name: string;
  reported_path: string;
  permission_blob: object;
  instructions?: string;
}

interface HubShareSyncMessage {
  type: "hub_share_sync";
  shares: unknown;
}

async function handleHubShareSync(conn: ConnectedExecutor, msg: HubShareSyncMessage): Promise<void> {
  if (conn.tokenType !== ExecutorTokenType.HUB) {
    send(conn.ws, { type: "hub_share_sync_error", error: "hub_share_sync is only valid for HUB tokens (ExecutorTokenType.HUB)" });
    return;
  }

  const rawShares = msg.shares;
  if (!Array.isArray(rawShares)) {
    send(conn.ws, { type: "hub_share_sync_error", error: "shares must be an array" });
    return;
  }

  const shares = rawShares as HubShareEntry[];

  // Validate shape
  for (const entry of shares) {
    if (typeof entry !== "object" || entry === null) {
      send(conn.ws, { type: "hub_share_sync_error", error: "Each share entry must be an object" });
      return;
    }
    if (typeof entry.name !== "string" || !entry.name) {
      send(conn.ws, { type: "hub_share_sync_error", error: "Each share entry must have a name string" });
      return;
    }
    if (typeof entry.reported_path !== "string" || !entry.reported_path) {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': reported_path must be a non-empty string` });
      return;
    }
    if (typeof entry.permission_blob !== "object" || entry.permission_blob === null) {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': permission_blob must be an object` });
      return;
    }
    if (entry.instructions !== undefined && typeof entry.instructions !== "string") {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': instructions must be a string` });
      return;
    }
  }

  // Upsert shares and remove stale entries in a transaction
  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of shares) {
        const instructions = typeof entry.instructions === "string" ? entry.instructions : null;
        await tx.hubShare.upsert({
          where: { executorId_share: { executorId: conn.executorId, share: entry.name } },
          create: {
            executorId: conn.executorId,
            share: entry.name,
            reportedPath: entry.reported_path,
            permissionBlob: entry.permission_blob,
            instructions,
          },
          update: {
            reportedPath: entry.reported_path,
            permissionBlob: entry.permission_blob,
            instructions,
          },
        });
      }

      const activeShares = shares.map((e) => e.name);
      await tx.hubShare.deleteMany({
        where: {
          executorId: conn.executorId,
          share: { notIn: activeShares },
        },
      });
    });
  } catch (err) {
    log.error({ err, executorId: conn.executorId }, "Failed to sync hub shares");
    send(conn.ws, { type: "hub_share_sync_error", error: "Internal error during share sync" });
    return;
  }

  log.info({ executorId: conn.executorId, count: shares.length }, "Hub shares synced");
  send(conn.ws, { type: "hub_share_sync_ok" });
}

// ---------------------------------------------------------------------------
// RPC dispatch (used by the request router in section 5)
// ---------------------------------------------------------------------------

export type { RpcError };
export { getConnection };

/** Revokes ExecutorToken rows that are not referenced by any Executor, were never revoked, and have
 * passed their expiry. Handles tokens left behind by a relay restart mid-rotation. Fresh
 * rotation tokens (expiresAt in the future) are left intact so the executor can complete rotation.
 * Called at startup and on the periodic prune interval. */
export async function pruneExpiredOrphanedTokens(): Promise<void> {
  const result = await prisma.executorToken.updateMany({
    where: { revokedAt: null, executors: { none: {} }, expiresAt: { lt: new Date() } },
    data: { revokedAt: new Date() },
  });
  if (result.count > 0) {
    log.warn({ count: result.count }, "Revoked orphaned executor tokens from prior restart");
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

/** Rejects all pending RPCs for a given executor — called on disconnect. */
export function rejectExecutorRpcs(executorId: string): void {
  rejectPendingRpcsForExecutor(executorId, new Error("executor_disconnected"));
}

export function dispatchRpc(
  executorId: string,
  payload: RpcEnvelope
): Promise<RpcResponse> {
  const conn = getConnection(executorId);
  if (!conn) throw new Error(`Executor ${executorId} is not connected`);

  const requestId = payload["request_id"] as string;
  const promise = dispatchPendingRpc(requestId, executorId, RPC_TIMEOUT_MS);
  send(conn.ws, payload);
  return promise;
}

function routeRpcResponse(respondingExecutorId: string, msg: RpcResponse): void {
  const requestId = msg.request_id;
  if (!requestId) return;

  const result = resolvePendingRpc(requestId, respondingExecutorId, msg);
  if (result === "owner_mismatch") {
    log.warn({ requestId, respondingExecutorId }, "Dropped RPC response from executor that did not own the request");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
