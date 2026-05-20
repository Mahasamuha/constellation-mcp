import { Router, Request, Response, IRouter } from "express";
import { prisma } from "./db.js";
import { requireBrokerManage, AuthenticatedRequest } from "./middleware.js";
import { getConnection } from "./hub.js";
import { createLogger } from "@constellation/shared";

const log = createLogger("api");

export const apiRouter: IRouter = Router();

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
    version: "0.1.0",
  });
});

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

apiRouter.get("/api/agents", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;

  const agents = await prisma.agent.findMany({
    where: { userId: uid },
    include: {
      pathLabels: { select: { label: true, reportedPath: true } },
      agentToken: { select: { id: true, lastUsedAt: true } },
    },
    orderBy: { registeredAt: "desc" },
  });

  res.json(agents.map((a) => ({
    id: a.id,
    host: a.host,
    registered_at: a.registeredAt.toISOString(),
    last_heartbeat_at: a.lastHeartbeatAt?.toISOString() ?? null,
    online: isOnline(a.lastHeartbeatAt),
    connected: getConnection(a.id) !== undefined,
    token_id: a.agentToken.id,
    token_last_used_at: a.agentToken.lastUsedAt?.toISOString() ?? null,
    labels: a.pathLabels.map((pl) => ({ label: pl.label, reported_path: pl.reportedPath })),
  })));
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

  const labels = await prisma.pathLabel.findMany({
    where: {
      userId: uid,
      ...(agentId ? { agentId } : {}),
    },
    include: { agent: { select: { host: true } } },
    orderBy: { label: "asc" },
  });

  res.json(labels.map((l) => ({
    id: l.id,
    label: l.label,
    reported_path: l.reportedPath,
    agent_id: l.agentId,
    host: l.agent.host,
  })));
});

// ---------------------------------------------------------------------------
// GET /api/filters
// ---------------------------------------------------------------------------

apiRouter.get("/api/filters", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;

  const filters = await prisma.brokerPathFilter.findMany({
    where: { scopeUserId: uid },
    orderBy: { createdAt: "desc" },
  });

  res.json(filters.map((f) => ({
    id: f.id,
    pattern: f.pattern,
    pattern_type: f.patternType,
    scope_agent_id: f.scopeAgentId,
    created_at: f.createdAt.toISOString(),
  })));
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
      new RegExp(pattern);
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

  const sessions = await prisma.oauthSession.findMany({
    where: { userId: uid, expiresAt: { gt: new Date() } },
    include: { mcpClient: { select: { isDynamic: true } } },
    orderBy: { issuedAt: "desc" },
  });

  res.json(sessions.map((s) => ({
    id: s.id,
    mcp_client_id: s.mcpClientId,
    is_dynamic_client: s.mcpClient.isDynamic,
    issued_at: s.issuedAt.toISOString(),
    expires_at: s.expiresAt.toISOString(),
    has_refresh_token: s.refreshTokenHash !== null,
    refresh_token_expires_at: s.refreshTokenExpiresAt?.toISOString() ?? null,
  })));
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
