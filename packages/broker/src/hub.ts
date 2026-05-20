import { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { hashToken, generateToken, createLogger } from "@constellation/shared";

const log = createLogger("hub");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  userId: string;
  host: string;
  tokenId: string;
  /** Token id to revoke once this connection is confirmed healthy (post-rotation). */
  pendingRevocationTokenId?: string;
  lastPongAt: number;
  missedPings: number;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Primary connection map: agentId → connected agent state */
const connections = new Map<string, ConnectedAgent>();

/** Reverse lookup: tokenId → agentId (for reconnect rate limiting) */
const tokenIndex = new Map<string, string>();

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

    const agent = agentToken.agents[0];
    if (!agent) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
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
      });
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, meta: {
    agentId: string;
    userId: string;
    host: string;
    tokenId: string;
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
}): Promise<void> {
    const { agentId, userId, host, tokenId } = meta;

    // Handle duplicate connections — terminate the old one.
    const existing = connections.get(agentId);
    if (existing) {
      log.info({ agentId, host }, "Replacing stale agent connection");
      existing.ws.terminate();
    }

    // If a previous token rotation is pending, revoke the old token now that
    // the agent has successfully reconnected with the new one.
    const prevTokenId = existing?.tokenId;
    if (prevTokenId && prevTokenId !== tokenId) {
      try {
        await prisma.agentToken.update({
          where: { id: prevTokenId },
          data: { revokedAt: new Date() },
        });
      } catch (err) {
        log.error({ err, prevTokenId }, "Failed to revoke old agent token — closing new connection");
        ws.close(1011, "Internal error during token rotation");
        return;
      }
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
      connections.delete(agentId);
      tokenIndex.delete(tokenId);
      rejectAgentRpcs(agentId);
      log.info({ agentId, host, userId }, "Agent disconnected");
    });

    ws.on("error", (err) => {
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
    routeRpcResponse(msg);
    return;
  }

  const type = msg["type"];

  if (type === "config_update") {
    await handleConfigUpdate(conn, msg);
  } else if (type === "update_host") {
    await handleUpdateHost(conn, msg);
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

async function handleConfigUpdate(conn: ConnectedAgent, msg: Record<string, unknown>): Promise<void> {
  const paths = msg["paths"];
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

async function handleUpdateHost(conn: ConnectedAgent, msg: Record<string, unknown>): Promise<void> {
  const newHost = typeof msg["host"] === "string" ? msg["host"].trim() : "";

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

  await prisma.agent.update({
    where: { id: conn.agentId },
    data: { agentTokenId: newAgentToken.id },
  });

  // The old token is revoked when the agent reconnects with the new one (see attachHub).
  log.info({ agentId: conn.agentId }, "Token rotation prepared");
  send(conn.ws, { type: "token_rotated", token: newToken });
}

// ---------------------------------------------------------------------------
// RPC dispatch (used by the request router in section 5)
// ---------------------------------------------------------------------------

interface RpcResponse {
  request_id: string;
  result?: unknown;
  error?: unknown;
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
  payload: Record<string, unknown>
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

function routeRpcResponse(msg: Record<string, unknown>): void {
  const requestId = msg["request_id"] as string | undefined;
  if (!requestId) return;

  const pending = pendingRpcs.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRpcs.delete(requestId);
  pending.resolve(msg as unknown as RpcResponse);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
