import { createRequire } from "node:module";
import RE2 from "re2";
import { Router, Request, Response, IRouter } from "express";
import { ExecutorTokenType } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { requireBearerAuth, requireAdmin, AuthenticatedRequest } from "./middleware.js";
import { getConnection } from "./hub.js";
import { type ActivityEventType } from "./activity.js";
import { createLogger, generateToken, hashToken, type ExecutorEntry } from "@constellation/shared";
import { config } from "./config.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const log = createLogger("api");

export const apiRouter: IRouter = Router();

function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(1, parseInt(String(req.query["limit"] ?? "100"), 10) || 100), 1000);
  const offset = Math.max(0, parseInt(String(req.query["offset"] ?? "0"), 10) || 0);
  return { limit, offset };
}

apiRouter.use(requireBearerAuth);

const HEARTBEAT_THRESHOLD_MS = config.heartbeat.intervalMs * config.heartbeat.maxMissed;

export function isOnline(lastHeartbeatAt: Date | null): boolean {
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
// GET /api/me — the caller's id plus the scopes and groups on the access token
// ---------------------------------------------------------------------------

apiRouter.get("/api/me", (req: Request, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  res.json({ user_id: user.id, scopes: user.scopes, groups: user.groups });
});

// ---------------------------------------------------------------------------
// GET /api/executors
// ---------------------------------------------------------------------------

apiRouter.get("/api/executors", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).user.id;
  const { limit, offset } = parsePagination(req);

  const [executors, total] = await Promise.all([
    prisma.executor.findMany({
      where: { userId: uid },
      include: {
        pathShares: { select: { share: true, reportedPath: true } },
        executorToken: { select: { id: true, lastUsedAt: true } },
      },
      orderBy: { host: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.executor.count({ where: { userId: uid } }),
  ]);

  // Typed against the shared ExecutorEntry contract (not just an inline literal) so a
  // future field rename here is caught by tsc at this call site, instead of silently
  // going unnoticed through the CLI's --json output and node-gui's Rust/frontend layers.
  const data: ExecutorEntry[] = executors.map((e) => ({
    id: e.id,
    host: e.host,
    registered_at: e.registeredAt.toISOString(),
    last_heartbeat_at: e.lastHeartbeatAt?.toISOString() ?? null,
    last_disconnect_reason: e.lastDisconnectReason,
    online: isOnline(e.lastHeartbeatAt),
    connected: getConnection(e.id) !== undefined,
    token_id: e.executorToken.id,
    token_last_used_at: e.executorToken.lastUsedAt?.toISOString() ?? null,
    shares: e.pathShares.map((ps) => ({ share: ps.share, reported_path: ps.reportedPath })),
  }));

  res.json({ data, total, limit, offset });
});

// ---------------------------------------------------------------------------
// DELETE /api/executors/:id/token — revoke executor token
// ---------------------------------------------------------------------------

apiRouter.delete("/api/executors/:id/token", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).user.id;
  const executorId = req.params["id"] as string;

  const executor = await prisma.executor.findFirst({
    where: { id: executorId, userId: uid },
    include: { executorToken: { select: { id: true, revokedAt: true } } },
  });

  if (!executor) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  if (executor.executorToken.revokedAt !== null) {
    res.status(409).json({ error: "already_revoked" });
    return;
  }

  await prisma.executorToken.update({
    where: { id: executor.executorToken.id },
    data: { revokedAt: new Date() },
  });

  // Terminate any active WebSocket connection for this executor.
  const conn = getConnection(executorId);
  if (conn) conn.ws.terminate();

  log.info({ executorId, userId: uid }, "Executor token revoked");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /api/shares
// ---------------------------------------------------------------------------

apiRouter.get("/api/shares", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).user.id;
  const executorId = typeof req.query["executor_id"] === "string" ? req.query["executor_id"] : undefined;
  const { limit, offset } = parsePagination(req);
  const where = { userId: uid, ...(executorId ? { executorId } : {}) };

  const [shares, total] = await Promise.all([
    prisma.pathShare.findMany({
      where,
      include: { executor: { select: { host: true } } },
      orderBy: { share: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.pathShare.count({ where }),
  ]);

  res.json({
    data: shares.map((s) => ({
      id: s.id,
      share: s.share,
      reported_path: s.reportedPath,
      executor_id: s.executorId,
      host: s.executor.host,
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
  const uid = (req as AuthenticatedRequest).user.id;
  const { limit, offset } = parsePagination(req);

  const [filters, total] = await Promise.all([
    prisma.relayPathFilter.findMany({
      where: { scopeUserId: uid },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.relayPathFilter.count({ where: { scopeUserId: uid } }),
  ]);

  res.json({
    data: filters.map((f) => ({
      id: f.id,
      pattern: f.pattern,
      pattern_type: f.patternType,
      scope_executor_id: f.scopeExecutorId,
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
  const uid = (req as AuthenticatedRequest).user.id;
  const body = req.body as Record<string, unknown>;

  const pattern = typeof body["pattern"] === "string" ? body["pattern"].trim() : "";
  if (!pattern) {
    res.status(400).json({ error: "invalid_request", error_description: "pattern is required" });
    return;
  }
  if (pattern.length > 1000) {
    res.status(400).json({ error: "invalid_request", error_description: "pattern must be 1000 characters or fewer" });
    return;
  }

  const patternType = body["pattern_type"];
  if (patternType !== "glob" && patternType !== "regex") {
    res.status(400).json({ error: "invalid_request", error_description: "pattern_type must be glob or regex" });
    return;
  }

  const executorId = typeof body["executor_id"] === "string" ? body["executor_id"] : undefined;
  if (executorId) {
    const executor = await prisma.executor.findFirst({ where: { id: executorId, userId: uid } });
    if (!executor) {
      res.status(404).json({ error: "not_found", error_description: "Executor not found" });
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

  const filter = await prisma.relayPathFilter.create({
    data: {
      scopeUserId: uid,
      scopeExecutorId: executorId ?? null,
      pattern,
      patternType,
    },
  });

  log.info({ filterId: filter.id, userId: uid, pattern, patternType }, "Relay filter created");
  res.status(201).json({
    id: filter.id,
    pattern: filter.pattern,
    pattern_type: filter.patternType,
    scope_executor_id: filter.scopeExecutorId,
    created_at: filter.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/filters/:id
// ---------------------------------------------------------------------------

apiRouter.delete("/api/filters/:id", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).user.id;
  const filterId = req.params["id"] as string;

  const filter = await prisma.relayPathFilter.findFirst({
    where: { id: filterId, scopeUserId: uid },
  });

  if (!filter) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.relayPathFilter.delete({ where: { id: filterId } });
  log.info({ filterId, userId: uid }, "Relay filter deleted");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /api/tokens/shared — break-glass hub token creation
// Preferred path is constellation hub register (POST /api/executors/register).
// ---------------------------------------------------------------------------

apiRouter.post("/api/tokens/shared", requireAdmin, async (_req: Request, res: Response) => {
  const token = generateToken();
  const tokenHash = hashToken(token);

  const executorToken = await prisma.executorToken.create({
    data: { userId: null, tokenType: ExecutorTokenType.HUB, tokenHash },
    select: { id: true, createdAt: true },
  });

  log.info({ tokenId: executorToken.id }, "Hub token created via break-glass API");
  res.status(201).json({
    token,
    token_id: executorToken.id,
    created_at: executorToken.createdAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/hub-shares — full hub share registry (admin-gated)
// ---------------------------------------------------------------------------

apiRouter.get("/api/admin/hub-shares", requireAdmin, async (req: Request, res: Response) => {
  const executorId = typeof req.query["executor_id"] === "string" ? req.query["executor_id"] : undefined;

  const shares = await prisma.hubShare.findMany({
    where: executorId ? { executorId } : {},
    include: { executor: { select: { id: true, host: true } } },
    orderBy: [{ executorId: "asc" }, { share: "asc" }],
  });

  res.json({
    data: shares.map((s) => ({
      executor_id: s.executorId,
      executor_host: s.executor.host,
      share: s.share,
      reported_path: s.reportedPath,
      permission_blob: s.permissionBlob,
      updated_at: s.updatedAt.toISOString(),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /api/activity
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = new Set<string>(["tool_call", "tool_error", "rate_limited", "executor_connect", "executor_disconnect"]);

function parseEventTypeFilter(req: Request, res: Response): { eventType?: ActivityEventType } | undefined {
  const rawEventType = typeof req.query["event_type"] === "string" ? req.query["event_type"] : undefined;
  if (rawEventType && !VALID_EVENT_TYPES.has(rawEventType)) {
    res.status(400).json({ error: "invalid_request", error_description: `Invalid event_type: ${rawEventType}` });
    return undefined;
  }
  return { eventType: rawEventType as ActivityEventType | undefined };
}

function serializeActivityEntry(e: {
  id: number;
  eventType: ActivityEventType;
  host: string | null;
  tool: string | null;
  share: string | null;
  requestId: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: e.id,
    event_type: e.eventType,
    host: e.host,
    tool: e.tool,
    share: e.share,
    request_id: e.requestId,
    duration_ms: e.durationMs,
    error_code: e.errorCode,
    error_message: e.errorMessage,
    created_at: e.createdAt.toISOString(),
  };
}

apiRouter.get("/api/activity", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).user.id;
  const { limit, offset } = parsePagination(req);
  const filter = parseEventTypeFilter(req, res);
  if (!filter) return;

  const where = { userId: uid, ...(filter.eventType ? { eventType: filter.eventType } : {}) };

  const [entries, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.activityLog.count({ where }),
  ]);

  res.json({
    data: entries.map(serializeActivityEntry),
    total,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/activity — events with no associated user (admin-gated)
//
// Connect/disconnect events for hubs have no single owning user, so
// they're excluded from GET /api/activity. Admins collectively own that data.
// ---------------------------------------------------------------------------

apiRouter.get("/api/admin/activity", requireAdmin, async (req: Request, res: Response) => {
  const { limit, offset } = parsePagination(req);
  const filter = parseEventTypeFilter(req, res);
  if (!filter) return;

  const where = { userId: null, ...(filter.eventType ? { eventType: filter.eventType } : {}) };

  const [entries, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.activityLog.count({ where }),
  ]);

  res.json({
    data: entries.map(serializeActivityEntry),
    total,
    limit,
    offset,
  });
});
