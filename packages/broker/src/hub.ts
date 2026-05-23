import { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { hashToken, generateToken, createLogger } from "@constellation/shared";

const log = createLogger("hub");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RpcEnvelope {
  request_id: string;
  tool: string;
  absolute_root: string;
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
  userId: string;
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
  const limit = parseInt(process.env["RATE_LIMIT_WS_RECONNECT_PER_MIN"] ?? "10", 10);
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

const HEARTBEAT_INTERVAL_MS =
  parseInt(process.env["HEARTBEAT_INTERVAL_SECONDS"] ?? "60", 10) * 1000;
const HEARTBEAT_MAX_MISSED = parseInt(process.env["HEARTBEAT_MAX_MISSED"] ?? "3", 10);

function startHeartbeatLoop(): void {
  setInterval(() => {
    for (const [agentId, conn] of connections) {
      conn.missedPings += 1;

      if (conn.missedPings > HEARTBEAT_MAX_MISSED) {
        log.warn({ agentId, lastPongAt: new Date(conn.lastPongAt) }, "Agent heartbeat timeout — terminating");
        conn.disconnectReason = "timeout";
        conn.ws.terminate();
        connections.delete(agentId);
        tokenIndex.delete(conn.tokenId);
        continue;
      }

      conn.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// WebSocket server setup
// ---------------------------------------------------------------------------

export function attachHub(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

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
        host: agent.host,
        tokenId: agentToken.id,
        pendingRotation,
      });
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, meta: {
    agentId: string;
    userId: string;
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
  userId: string;
  host: string;
  tokenId: string;
  pendingRotation?: PendingRotationEntry;
}): Promise<void> {
    const { agentId, userId, host, tokenId, pendingRotation } = meta;

    // Complete a pending token rotation: atomically update agentTokenId and revoke the old token,
    // then cancel the expiry timer.
    if (pendingRotation) {
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
      host,
      tokenId,
      lastPongAt: Date.now(),
      missedPings: 0,
    };

    connections.set(agentId, conn);
    tokenIndex.set(tokenId, agentId);

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
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        log.warn({ agentId }, "Received non-JSON message from agent");
        return;
      }
      handleAgentMessage(conn, msg).catch((err) =>
        log.error({ err, agentId }, "Error handling agent message")
      );
    });

    ws.on("close", () => {
      const reason = conn.disconnectReason ?? "clean";
      connections.delete(agentId);
      tokenIndex.delete(tokenId);
      rejectAgentRpcs(agentId);
      prisma.agent.update({
        where: { id: agentId },
        data: { lastHeartbeatAt: null, lastDisconnectReason: reason },
      }).catch((err) => log.error({ err, agentId }, "Failed to update disconnect state"));
      log.info({ agentId, host, userId, reason }, "Agent disconnected");
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
  } else {
    log.warn({ agentId: conn.agentId, type }, "Unknown control message from agent — dropping");
  }
}

interface PathEntry {
  label: string;
  reported_path: string;
}

async function handleConfigUpdate(conn: ConnectedAgent, msg: ConfigUpdateMessage): Promise<void> {
  const paths = msg.paths;
  if (!Array.isArray(paths)) {
    send(conn.ws, { type: "config_update_error", error: "paths must be an array" });
    return;
  }

  const entries = paths as PathEntry[];

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

  // Check for label conflicts — another agent on the same user already owns any of these labels.
  for (const entry of entries) {
    const conflict = await prisma.pathLabel.findFirst({
      where: {
        userId: conn.userId,
        label: entry.label,
        NOT: { agentId: conn.agentId },
      },
    });
    if (conflict) {
      send(conn.ws, {
        type: "config_update_error",
        error: `Label "${entry.label}" is already registered by another agent`,
      });
      return;
    }
  }

  // Upsert all provided labels and remove any that are no longer present.
  await prisma.$transaction(async (tx) => {
    for (const entry of entries) {
      await tx.pathLabel.upsert({
        where: { userId_label: { userId: conn.userId, label: entry.label } },
        create: {
          userId: conn.userId,
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

  log.info({ agentId: conn.agentId, count: entries.length }, "Config updated");
  send(conn.ws, { type: "config_update_ok" });
}

async function handleUpdateHost(conn: ConnectedAgent, msg: UpdateHostMessage): Promise<void> {
  const newHost = typeof msg.host === "string" ? msg.host.trim() : "";

  if (!newHost) {
    send(conn.ws, { type: "update_host_error", error: "host must be a non-empty string" });
    return;
  }

  const conflict = await prisma.agent.findFirst({
    where: { userId: conn.userId, host: newHost, NOT: { id: conn.agentId } },
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
    data: { userId: conn.userId, tokenHash: newTokenHash },
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
// RPC dispatch (used by the request router in section 5)
// ---------------------------------------------------------------------------

export interface RpcError {
  message: string;
  code?: string;
  edit_index?: number;
  match_count?: number;
  read_size_kb?: number;
  max_file_size_kb?: number;
  path?: string;
}

interface RpcResponse {
  request_id: string;
  result?: object;
  error?: RpcError;
}

const pendingRpcs = new Map<string, {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  agentId: string;
}>();

export function getConnection(agentId: string): ConnectedAgent | undefined {
  return connections.get(agentId);
}

/** Rejects all pending RPCs for a given agent — called on disconnect. */
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

export function rejectAgentRpcs(agentId: string): void {
  for (const [requestId, pending] of pendingRpcs) {
    if (pending.agentId === agentId) {
      clearTimeout(pending.timer);
      pendingRpcs.delete(requestId);
      pending.reject(new Error("timeout"));
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
  const timeoutMs = parseInt(process.env["RPC_TIMEOUT_MS"] ?? "30000", 10);

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
