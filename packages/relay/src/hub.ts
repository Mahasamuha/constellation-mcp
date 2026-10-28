import { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { ExecutorTokenType, Prisma } from "./generated/prisma/client.js";
import { logEvent } from "./activity.js";
import { hashToken, generateToken, EXECUTOR_TOKEN_PATTERN, SHARE_NAME_PATTERN, sanitizeMultilineText, createLogger, type RpcError, type RpcResponse, type RpcEnvelope as BaseRpcEnvelope } from "@constellation/shared";
import { config } from "./config.js";
import { validateHostName } from "./host-name.js";
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
  /** The asterism sub (= users.id). */
  user_sub: string;
  /** The caller's groups, unfiltered: hubs evaluate group overrides that may restrict access. */
  user_groups: string[];
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

/** Minimum gap between two rotate_token requests from one executor. */
const ROTATE_MIN_INTERVAL_MS = 60_000;
const lastRotateAt = new Map<string, number>();

/** Messages (and pongs) one connection may send per window before it is closed. */
const MSG_RATE_WINDOW_MS = 10_000;
const MSG_RATE_MAX = 500;

/** Minimum gap between last_heartbeat_at writes for one executor. */
const HEARTBEAT_WRITE_MIN_INTERVAL_MS = 10_000;

/** Upgrade attempts one client address may make per minute, successful or not, checked before any DB work. */
/** How long a revoked, unreferenced token row is kept before the prune deletes it. */
const REVOKED_TOKEN_RETENTION_MS = 60 * 60 * 1000;

const UPGRADE_PER_IP_PER_MIN = 120;

/** Most entries one config_update or hub_share_sync may carry. */
export const MAX_CONFIG_UPDATE_ENTRIES = 256;
export const MAX_HUB_SHARE_ENTRIES = 1000;

const MAX_INSTRUCTIONS_LENGTH = 4096;

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

const upgradeTimestamps = new Map<string, number[]>();

function checkUpgradeRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = (upgradeTimestamps.get(ip) ?? []).filter((t) => now - t < 60_000);
  timestamps.push(now);
  upgradeTimestamps.set(ip, timestamps);
  return timestamps.length <= UPGRADE_PER_IP_PER_MIN;
}

/** The client address for an upgrade request. Behind a trusted proxy (the socket peer is loopback
 * or private) the nearest proxy's X-Forwarded-For entry is used, as with Express `trust proxy`. */
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const isInternal = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168)\.|f[cd][0-9a-f]{2}:)/i.test(peer);
  const xff = req.headers["x-forwarded-for"];
  if (isInternal && typeof xff === "string") {
    const last = xff.split(",").pop()?.trim();
    if (last) return last;
  }
  return peer;
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

      conn.awaitingPong = true;
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

async function handleUpgradeRequest(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  if (!checkUpgradeRateLimit(clientIp(req))) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

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
}

export function attachHub(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES });
  _wss = wss;

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    // An upgrade socket has no HTTP error handler: an unhandled ECONNRESET would crash the process.
    socket.on("error", (err) => log.debug({ err }, "Upgrade socket error"));
    // Must never become an unhandled rejection: index.ts exits the process on one.
    handleUpgradeRequest(wss, req, socket, head).catch((err) => {
      log.error({ err }, "Executor upgrade failed");
      try { socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n"); } catch { /* socket already gone */ }
      socket.destroy();
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
          // The rotation token was minted with a 5-minute expiry; once adopted it is the executor's
          // permanent token, so a reconnect after that window must still authenticate.
          prisma.executorToken.update({ where: { id: tokenId }, data: { expiresAt: null } }),
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

    // Sliding count of messages and pongs; a connection over the limit is closed.
    let windowStart = Date.now();
    let windowCount = 0;
    let lastHeartbeatWriteAt = Date.now();
    const overRateLimit = (): boolean => {
      const now = Date.now();
      if (now - windowStart >= MSG_RATE_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount <= MSG_RATE_MAX) return false;
      log.warn({ executorId, limit: MSG_RATE_MAX }, "Executor message rate exceeded — closing");
      conn.disconnectReason = "error";
      ws.close(1008, "Message rate limit exceeded");
      // A client that ignores the close handshake must not hold the slot.
      setTimeout(() => ws.terminate(), 1000).unref();
      return true;
    };

    ws.on("pong", () => {
      if (overRateLimit()) return;
      // Only a pong answering our ping counts; unsolicited pongs are ignored.
      if (!conn.awaitingPong) return;
      conn.awaitingPong = false;
      const now = Date.now();
      conn.lastPongAt = now;
      conn.missedPings = 0;
      if (now - lastHeartbeatWriteAt < HEARTBEAT_WRITE_MIN_INTERVAL_MS) return;
      lastHeartbeatWriteAt = now;
      prisma.executor.update({
        where: { id: executorId },
        data: { lastHeartbeatAt: new Date() },
      }).catch((err) => log.error({ err, executorId }, "Failed to update last_heartbeat_at"));
    });

    ws.on("message", (data) => {
      if (overRateLimit()) return;
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

export async function handleConfigUpdate(conn: ConnectedExecutor, msg: ConfigUpdateMessage): Promise<void> {
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
  if (entries.length > MAX_CONFIG_UPDATE_ENTRIES) {
    send(conn.ws, { type: "config_update_error", error: `config_update may carry at most ${MAX_CONFIG_UPDATE_ENTRIES} paths` });
    return;
  }

  // Validate all shares before writing anything.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !entry.share || !entry.reported_path) {
      send(conn.ws, { type: "config_update_error", error: "Each path entry must have share and reported_path" });
      return;
    }
    if (typeof entry.share !== "string" || !SHARE_NAME_PATTERN.test(entry.share)) {
      send(conn.ws, { type: "config_update_error", error: "share must be 1-64 characters: letters, digits, '.', '_' or '-'" });
      return;
    }
    if (typeof entry.reported_path !== "string") {
      send(conn.ws, { type: "config_update_error", error: "reported_path must be a string" });
      return;
    }
    if (entry.instructions !== undefined && typeof entry.instructions !== "string") {
      send(conn.ws, { type: "config_update_error", error: `Share '${entry.share}': instructions must be a string` });
      return;
    }
    if (typeof entry.instructions === "string" && entry.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      send(conn.ws, { type: "config_update_error", error: `Share '${entry.share}': instructions must not exceed ${MAX_INSTRUCTIONS_LENGTH} characters` });
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
        const instructions = typeof entry.instructions === "string" ? sanitizeMultilineText(entry.instructions) : null;
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

export async function handleUpdateHost(conn: ConnectedExecutor, msg: UpdateHostMessage): Promise<void> {
  if (conn.tokenType === ExecutorTokenType.HUB) {
    send(conn.ws, { type: "update_host_error", error: "Hubs use a fixed host (machine ID); update_host is not supported" });
    return;
  }
  const validated = validateHostName(msg.host);
  if ("error" in validated) {
    send(conn.ws, { type: "update_host_error", error: validated.error });
    return;
  }
  const newHost = validated.host;

  // No separate conflict check beforehand — the write doesn't depend on the row's
  // current host, so there's nothing for a check-then-write race to act on. Attempt
  // the write directly and let the (user_id, host) partial unique index reject a
  // conflict atomically, in the same statement, instead of a SELECT-then-UPDATE pair
  // two concurrent renames could both pass.
  try {
    await prisma.executor.update({ where: { id: conn.executorId }, data: { host: newHost } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      send(conn.ws, { type: "update_host_error", error: `Host name "${newHost}" is already registered` });
      return;
    }
    throw err;
  }
  conn.host = newHost;

  log.info({ executorId: conn.executorId, newHost }, "Executor host updated");
  send(conn.ws, { type: "update_host_ok", host: newHost });
}

export async function handleRotateToken(conn: ConnectedExecutor): Promise<void> {
  const now = Date.now();
  const last = lastRotateAt.get(conn.executorId);
  if (last !== undefined && now - last < ROTATE_MIN_INTERVAL_MS) {
    send(conn.ws, { type: "rotate_token_error", error: "rotate_token is limited to once per minute" });
    return;
  }
  lastRotateAt.set(conn.executorId, now);

  const newToken = generateToken();
  // The only executor token the relay ever sends is one it just minted.
  if (!EXECUTOR_TOKEN_PATTERN.test(newToken)) throw new Error("generateToken returned a malformed token");
  const newTokenHash = hashToken(newToken);

  // Cancel any prior pending rotation for this executor to avoid orphaned tokens.
  await cancelPendingRotation(conn.executorId);

  const newExecutorToken = await prisma.executorToken.create({
    data: {
      userId: conn.userId,
      tokenType: conn.tokenType,
      tokenHash: newTokenHash,
      expiresAt: new Date(Date.now() + ROTATION_TTL_MS),
    },
    select: { id: true },
  });

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

/** Cancels any pending token rotation for the executor and revokes the pending rotation token.
 * Called when the executor's token is revoked or replaced, so a rotation token minted earlier
 * cannot be adopted afterwards. */
export async function cancelPendingRotation(executorId: string): Promise<void> {
  const tokenIds: string[] = [];
  for (const [tokenId, entry] of pendingRotations) {
    if (entry.executorId === executorId) {
      clearTimeout(entry.timer);
      pendingRotations.delete(tokenId);
      tokenIds.push(tokenId);
    }
  }
  if (tokenIds.length === 0) return;
  await prisma.executorToken.updateMany({
    where: { id: { in: tokenIds }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
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

export async function handleHubShareSync(conn: ConnectedExecutor, msg: HubShareSyncMessage): Promise<void> {
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
  if (shares.length > MAX_HUB_SHARE_ENTRIES) {
    send(conn.ws, { type: "hub_share_sync_error", error: `hub_share_sync may carry at most ${MAX_HUB_SHARE_ENTRIES} shares` });
    return;
  }

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
    if (!SHARE_NAME_PATTERN.test(entry.name)) {
      send(conn.ws, { type: "hub_share_sync_error", error: "Share name must be 1-64 characters: letters, digits, '.', '_' or '-'" });
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
    const blob = entry.permission_blob as Record<string, unknown>;
    const validAccess = new Set(["none", "read-only", "read-write"]);
    if (!validAccess.has(blob["default"] as string)) {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': permission_blob.default must be "none", "read-only", or "read-write"` });
      return;
    }
    if (blob["overrides"] !== undefined) {
      if (!Array.isArray(blob["overrides"])) {
        send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': permission_blob.overrides must be an array` });
        return;
      }
      for (const [idx, o] of (blob["overrides"] as unknown[]).entries()) {
        const ov = (typeof o === "object" && o !== null ? o : null) as Record<string, unknown> | null;
        let problem: string | null = null;
        if (!ov) {
          problem = "must be an object";
        } else if ("oidc_sub" in ov) {
          problem = "uses the removed key oidc_sub; re-key it to sub (the asterism user id) or group (a group name)";
        } else {
          const hasSub = typeof ov["sub"] === "string" && ov["sub"] !== "";
          const hasGroup = typeof ov["group"] === "string" && ov["group"] !== "";
          if ((ov["sub"] !== undefined && !hasSub) || (ov["group"] !== undefined && !hasGroup) || hasSub === hasGroup) {
            problem = "must have exactly one of sub or group (a non-empty string)";
          } else if (!validAccess.has(ov["access"] as string)) {
            problem = 'access must be "none", "read-only", or "read-write"';
          }
        }
        if (problem) {
          send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': permission_blob.overrides[${idx}] ${problem}` });
          return;
        }
      }
    }
    if (entry.instructions !== undefined && typeof entry.instructions !== "string") {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': instructions must be a string` });
      return;
    }
    if (typeof entry.instructions === "string" && entry.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      send(conn.ws, { type: "hub_share_sync_error", error: `Share '${entry.name}': instructions must not exceed ${MAX_INSTRUCTIONS_LENGTH} characters` });
      return;
    }
  }

  // Upsert shares and remove stale entries in a transaction
  try {
    await prisma.$transaction(async (tx) => {
      for (const entry of shares) {
        const instructions = typeof entry.instructions === "string" ? sanitizeMultilineText(entry.instructions) : null;
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
  // Superseded rotation tokens and old tokens replaced by a completed rotation stay revoked and
  // unreferenced; delete them after a grace period.
  const deleted = await prisma.executorToken.deleteMany({
    where: { revokedAt: { lt: new Date(Date.now() - REVOKED_TOKEN_RETENTION_MS) }, executors: { none: {} } },
  });
  if (deleted.count > 0) {
    log.info({ count: deleted.count }, "Deleted revoked, unreferenced executor tokens");
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
  for (const [ip, ts] of upgradeTimestamps) {
    const fresh = ts.filter((t) => now - t < window);
    if (fresh.length === 0) upgradeTimestamps.delete(ip);
    else upgradeTimestamps.set(ip, fresh);
  }
  for (const [id, at] of lastRotateAt) {
    if (now - at >= ROTATE_MIN_INTERVAL_MS) lastRotateAt.delete(id);
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
