import { createRequire } from "node:module";
import RE2 from "re2";
import { Router, Request, Response, IRouter } from "express";
import { prisma } from "./db.js";
import { requireBrokerManage, AuthenticatedRequest } from "./middleware.js";
import { getConnection } from "./hub.js";
import { createLogger } from "@constellation/shared";
import { createLocalUser } from "./local-auth.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const log = createLogger("api");

export const apiRouter: IRouter = Router();

function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, parseInt(String(req.query["limit"] ?? "100"), 10) || 100), 1000);
  const offset = Math.max(0, parseInt(String(req.query["offset"] ?? "0"), 10) || 0);
  return { limit, offset };
}

apiRouter.use(requireBrokerManage);

const HEARTBEAT_THRESHOLD_MS =
  parseInt(process.env["HEARTBEAT_INTERVAL_SECONDS"] ?? "60", 10) *
  parseInt(process.env["HEARTBEAT_MAX_MISSED"] ?? "3", 10) *
  1000;

function isOnline(lastHeartbeatAt: Date | null): boolean {
  if (!lastHeartbeatAt) return false;
  return Date.now() - lastHeartbeatAt.getTime() < HEARTBEAT_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------

const startedAt = new Date();

apiRouter.get("/api/status", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    version,
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

apiRouter.get("/api/agents", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const { limit, offset } = parsePagination(req);

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where: { userId: uid },
      include: {
        pathLabels: { select: { label: true, reportedPath: true } },
        agentToken: { select: { id: true, lastUsedAt: true } },
      },
      orderBy: { host: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.agent.count({ where: { userId: uid } }),
  ]);

  res.json({
    data: agents.map((a) => ({
      id: a.id,
      host: a.host,
      registered_at: a.registeredAt.toISOString(),
      last_heartbeat_at: a.lastHeartbeatAt?.toISOString() ?? null,
      last_disconnect_reason: a.lastDisconnectReason ?? null,
      online: isOnline(a.lastHeartbeatAt),
      connected: getConnection(a.id) !== undefined,
      token_id: a.agentToken.id,
      token_last_used_at: a.agentToken.lastUsedAt?.toISOString() ?? null,
      labels: a.pathLabels.map((pl) => ({ label: pl.label, reported_path: pl.reportedPath })),
    })),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/token — revoke agent token
// ---------------------------------------------------------------------------

apiRouter.delete("/api/agents/:id/token", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const agentId = req.params["id"] as string;

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, userId: uid },
    include: { agentToken: { select: { id: true, revokedAt: true } } },
  });

  if (!agent) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (agent.agentToken.revokedAt !== null) {
    res.status(409).json({ error: "already_revoked" });
    return;
  }

  await prisma.agentToken.update({
    where: { id: agent.agentToken.id },
    data: { revokedAt: new Date() },
  });

  // Terminate any active WebSocket connection for this agent.
  const conn = getConnection(agentId);
  if (conn) conn.ws.terminate();

  log.info({ agentId, userId: uid }, "Agent token revoked");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/labels
// ---------------------------------------------------------------------------

apiRouter.get("/api/labels", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const agentId = typeof req.query["agent_id"] === "string" ? req.query["agent_id"] : undefined;
  const { limit, offset } = parsePagination(req);
  const where = { userId: uid, ...(agentId ? { agentId } : {}) };

  const [labels, total] = await Promise.all([
    prisma.pathLabel.findMany({
      where,
      include: { agent: { select: { host: true } } },
      orderBy: { label: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.pathLabel.count({ where }),
  ]);

  res.json({
    data: labels.map((l) => ({
      id: l.id,
      label: l.label,
      reported_path: l.reportedPath,
      agent_id: l.agentId,
      host: l.agent.host,
    })),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// GET /api/filters
// ---------------------------------------------------------------------------

apiRouter.get("/api/filters", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const { limit, offset } = parsePagination(req);

  const [filters, total] = await Promise.all([
    prisma.brokerPathFilter.findMany({
      where: { scopeUserId: uid },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.brokerPathFilter.count({ where: { scopeUserId: uid } }),
  ]);

  res.json({
    data: filters.map((f) => ({
      id: f.id,
      pattern: f.pattern,
      pattern_type: f.patternType,
      scope_agent_id: f.scopeAgentId,
      created_at: f.createdAt.toISOString(),
    })),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// POST /api/filters
// ---------------------------------------------------------------------------

apiRouter.post("/api/filters", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const body = req.body as Record<string, unknown>;

  const pattern = typeof body["pattern"] === "string" ? body["pattern"].trim() : "";
  if (!pattern) {
    res.status(400).json({ error: "invalid_request", error_description: "pattern is required" });
    return;
  }

  const patternType = body["pattern_type"];
  if (patternType !== "glob" && patternType !== "regex") {
    res.status(400).json({ error: "invalid_request", error_description: "pattern_type must be glob or regex" });
    return;
  }

  const agentId = typeof body["agent_id"] === "string" ? body["agent_id"] : undefined;
  if (agentId) {
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: uid } });
    if (!agent) {
      res.status(404).json({ error: "not_found", error_description: "Agent not found" });
      return;
    }
  }

  // Validate regex compiles before storing.
  if (patternType === "regex") {
    try {
      new RE2(pattern);
    } catch {
      res.status(400).json({ error: "invalid_request", error_description: "Invalid regex pattern" });
      return;
    }
  }

  const filter = await prisma.brokerPathFilter.create({
    data: {
      scopeUserId: uid,
      scopeAgentId: agentId ?? null,
      pattern,
      patternType,
    },
  });

  log.info({ filterId: filter.id, userId: uid, pattern, patternType }, "Broker filter created");
  res.status(201).json({
    id: filter.id,
    pattern: filter.pattern,
    pattern_type: filter.patternType,
    scope_agent_id: filter.scopeAgentId,
    created_at: filter.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/filters/:id
// ---------------------------------------------------------------------------

apiRouter.delete("/api/filters/:id", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const filterId = req.params["id"] as string;

  const filter = await prisma.brokerPathFilter.findFirst({
    where: { id: filterId, scopeUserId: uid },
  });

  if (!filter) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.brokerPathFilter.delete({ where: { id: filterId } });
  log.info({ filterId, userId: uid }, "Broker filter deleted");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------

apiRouter.get("/api/sessions", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const { limit, offset } = parsePagination(req);
  const where = { userId: uid, expiresAt: { gt: new Date() } };

  const [sessions, total] = await Promise.all([
    prisma.oauthSession.findMany({
      where,
      include: { mcpClient: { select: { isDynamic: true } } },
      orderBy: { issuedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.oauthSession.count({ where }),
  ]);

  res.json({
    data: sessions.map((s) => ({
      id: s.id,
      mcp_client_id: s.mcpClientId,
      is_dynamic_client: s.mcpClient.isDynamic,
      issued_at: s.issuedAt.toISOString(),
      expires_at: s.expiresAt.toISOString(),
      has_refresh_token: s.refreshTokenHash !== null,
      refresh_token_expires_at: s.refreshTokenExpiresAt?.toISOString() ?? null,
    })),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/sessions/:id
// ---------------------------------------------------------------------------

apiRouter.delete("/api/sessions/:id", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const sessionId = req.params["id"] as string;

  const session = await prisma.oauthSession.findFirst({
    where: { id: sessionId, userId: uid },
  });

  if (!session) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Invalidate by setting expiry to now so all token lookups immediately fail.
  await prisma.oauthSession.update({
    where: { id: sessionId },
    data: { expiresAt: new Date(), refreshTokenExpiresAt: new Date() },
  });

  log.info({ sessionId, userId: uid }, "OAuth session revoked");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// User management — AUTH_MODE=local only
// ---------------------------------------------------------------------------
//
// Any broker:manage token grants full user-management access (list, create,
// deactivate, reset password). There is no separate admin role. This is
// intentional for single-user/small-team deployments where every operator is
// effectively an admin. A role-based access model would be needed if the broker
// were to support mixed-trust users with delegated management.

function requireLocalMode(res: Response): boolean {
  if (process.env["AUTH_MODE"] !== "local") {
    res.status(404).json({ error: "not_found", error_description: "User management is only available in AUTH_MODE=local" });
    return false;
  }
  return true;
}

apiRouter.get("/api/users", async (req: Request, res: Response) => {
  if (!requireLocalMode(res)) return;

  const users = await prisma.localUser.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true, isActive: true, createdAt: true, lastLoginAt: true },
  });

  res.json(users.map((u) => ({
    id: u.id,
    username: u.username,
    is_active: u.isActive,
    created_at: u.createdAt.toISOString(),
    last_login_at: u.lastLoginAt?.toISOString() ?? null,
  })));
});

apiRouter.post("/api/users", async (req: Request, res: Response) => {
  if (!requireLocalMode(res)) return;

  const body = req.body as Record<string, unknown>;
  const username = typeof body["username"] === "string" ? body["username"].trim() : "";
  const password = typeof body["password"] === "string" ? body["password"] : "";

  if (!username) {
    res.status(400).json({ error: "invalid_request", error_description: "username is required" });
    return;
  }

  if (username.length > 64) {
    res.status(400).json({ error: "invalid_request", error_description: "username must be 64 characters or fewer" });
    return;
  }

  if (password.length < 12) {
    res.status(400).json({ error: "invalid_request", error_description: "password must be at least 12 characters" });
    return;
  }

  try {
    const userId = await createLocalUser(username, password);
    const localUser = await prisma.localUser.findUnique({ where: { userId }, select: { id: true, username: true, createdAt: true } });
    log.info({ username }, "Local user created via API");
    res.status(201).json({ id: localUser!.id, username: localUser!.username, created_at: localUser!.createdAt.toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create user";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "conflict", error_description: "Username already taken" });
    } else {
      res.status(400).json({ error: "invalid_request", error_description: msg });
    }
  }
});

apiRouter.delete("/api/users/:username", async (req: Request, res: Response) => {
  if (!requireLocalMode(res)) return;

  const username = req.params["username"] as string;

  const localUser = await prisma.localUser.findUnique({
    where: { username },
    include: { user: { select: { id: true } } },
  });

  if (!localUser) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.$transaction([
    prisma.localUser.update({ where: { username }, data: { isActive: false } }),
    prisma.user.update({ where: { id: localUser.user.id }, data: { deactivatedAt: new Date() } }),
  ]);

  log.info({ username }, "Local user deactivated");
  res.status(204).end();
});

apiRouter.post("/api/users/:username/reset-password", async (req: Request, res: Response) => {
  if (!requireLocalMode(res)) return;

  const username = req.params["username"] as string;
  const body = req.body as Record<string, unknown>;
  const password = typeof body["password"] === "string" ? body["password"] : "";

  if (password.length < 12) {
    res.status(400).json({ error: "invalid_request", error_description: "password must be at least 12 characters" });
    return;
  }

  const localUser = await prisma.localUser.findUnique({
    where: { username },
    include: { user: { select: { id: true } } },
  });

  if (!localUser) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);

  // Invalidate all existing OAuth sessions for this user, then update hash.
  await prisma.$transaction([
    prisma.oauthSession.updateMany({
      where: { userId: localUser.user.id },
      data: { expiresAt: new Date(), refreshTokenExpiresAt: new Date() },
    }),
    prisma.localUser.update({ where: { username }, data: { passwordHash } }),
  ]);

  log.info({ username }, "Local user password reset");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /api/account/deactivate
// ---------------------------------------------------------------------------

apiRouter.post("/api/account/deactivate", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
  const body = req.body as Record<string, unknown>;

  // Require explicit confirmation string to prevent accidental deactivation.
  if (body["confirm"] !== "deactivate my account") {
    res.status(400).json({
      error: "confirmation_required",
      error_description: "Send confirm:\"deactivate my account\" to proceed",
    });
    return;
  }

  await prisma.user.update({
    where: { id: uid },
    data: { deactivatedAt: new Date() },
  });

  log.info({ userId: uid }, "Account deactivated");
  res.status(204).end();
});
