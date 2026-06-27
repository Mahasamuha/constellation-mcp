import { createRequire } from "node:module";
import RE2 from "re2";
import { Router, Request, Response, IRouter } from "express";
import { ExecutorTokenType, RelayRole } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { requireBearerAuth, requireAdmin, AuthenticatedRequest } from "./middleware.js";
import { getConnection } from "./hub.js";
import { type ActivityEventType } from "./activity.js";
import { createLogger, generateToken, hashToken, safeEqual, type ExecutorEntry } from "@constellation/shared";
import { config } from "./config.js";
import { createLocalUser } from "./local-auth.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const log = createLogger("api");

export const apiRouter: IRouter = Router();

// Routes protected by RELAY_ADMIN_TOKEN (not OAuth) must be on a separate
// router so that requireBearerAuth (applied to apiRouter below) does not reject
// the admin token before the route handler can validate it.
export const adminTokenRouter: IRouter = Router();

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
// GET /api/me — return current session info (used by CLI to get session_id
// before initiating an escalation device code flow)
// ---------------------------------------------------------------------------

apiRouter.get("/api/me", (req: Request, res: Response) => {
  const ar = req as AuthenticatedRequest;
  res.json({ session_id: ar.sessionId, user_id: ar.userId });
});

// ---------------------------------------------------------------------------
// GET /api/executors
// ---------------------------------------------------------------------------

apiRouter.get("/api/executors", async (req: Request, res: Response) => {
  const uid = (req as AuthenticatedRequest).userId;
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
  const uid = (req as AuthenticatedRequest).userId;
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
  const uid = (req as AuthenticatedRequest).userId;
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
  const uid = (req as AuthenticatedRequest).userId;
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
  const uid = (req as AuthenticatedRequest).userId;
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
  const uid = (req as AuthenticatedRequest).userId;
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
// POST /api/tokens/shared — break-glass hub token creation
// Preferred path is constellation hub register (§2.6, device code flow).
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
// User management — AUTH_MODE=local only
// ---------------------------------------------------------------------------

function requireLocalMode(res: Response): boolean {
  if (config.authMode !== "local") {
    res.status(404).json({ error: "not_found", error_description: "User management is only available in AUTH_MODE=local" });
    return false;
  }
  return true;
}

apiRouter.get("/api/users", requireAdmin, async (req: Request, res: Response) => {
  if (!requireLocalMode(res)) return;

  const { limit, offset } = parsePagination(req);
  const [users, total] = await Promise.all([
    prisma.localUser.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, isActive: true, createdAt: true, lastLoginAt: true },
      take: limit,
      skip: offset,
    }),
    prisma.localUser.count(),
  ]);

  res.json({
    data: users.map((u) => ({
      id: u.id,
      username: u.username,
      is_active: u.isActive,
      created_at: u.createdAt.toISOString(),
      last_login_at: u.lastLoginAt?.toISOString() ?? null,
    })),
    total,
    limit,
    offset,
  });
});

apiRouter.post("/api/users", requireAdmin, async (req: Request, res: Response) => {
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
    const msg = err instanceof Error ? err.message : "";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "conflict", error_description: "Username already taken" });
    } else {
      // Anything other than a unique-constraint violation is an unexpected DB/driver
      // error that may carry table/column/connection detail — log it server-side only,
      // never echo it to the caller (same pattern as executor/index.ts's buildError()).
      log.error({ err, username }, "Failed to create local user");
      res.status(400).json({ error: "invalid_request", error_description: "Failed to create user" });
    }
  }
});

apiRouter.post("/api/users/:username/deactivate", requireAdmin, async (req: Request, res: Response) => {
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

apiRouter.post("/api/users/:username/reset-password", requireAdmin, async (req: Request, res: Response) => {
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
// Role management (promote/demote) — protected by RELAY_ADMIN_TOKEN env var.
// For bootstrap before OIDC groups are configured, or in AUTH_MODE=local.
// Never exposed via an OAuth-gated route — requires the operator's admin token.
// ---------------------------------------------------------------------------

function requireRelayAdminToken(req: Request, res: Response): boolean {
  const adminToken = process.env["RELAY_ADMIN_TOKEN"];
  if (!adminToken) {
    res.status(404).json({ error: "not_found" });
    return false;
  }
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ") || !safeEqual(authHeader.slice(7), adminToken)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

adminTokenRouter.post("/api/admin/users/:identifier/promote", async (req: Request, res: Response) => {
  if (!requireRelayAdminToken(req, res)) return;
  const identifier = req.params["identifier"] as string;
  const user = await resolveUserByIdentifier(identifier);
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  await prisma.user.update({ where: { id: user.id }, data: { role: RelayRole.ADMIN } });
  log.info({ userId: user.id, identifier }, "User promoted to ADMIN via admin token");
  res.status(204).end();
});

adminTokenRouter.post("/api/admin/users/:identifier/demote", async (req: Request, res: Response) => {
  if (!requireRelayAdminToken(req, res)) return;
  const identifier = req.params["identifier"] as string;
  const user = await resolveUserByIdentifier(identifier);
  if (!user) { res.status(404).json({ error: "not_found" }); return; }
  await prisma.user.update({ where: { id: user.id }, data: { role: RelayRole.USER } });
  log.info({ userId: user.id, identifier }, "User demoted to USER via admin token");
  res.status(204).end();
});

/** Resolves a user by oidc_sub or (in AUTH_MODE=local) username. */
async function resolveUserByIdentifier(identifier: string): Promise<{ id: string } | null> {
  // Try oidc_sub first (format: "provider|sub" or just the sub string).
  const byOidcSub = await prisma.user.findFirst({
    where: { oidcSub: identifier },
    select: { id: true },
  });
  if (byOidcSub) return byOidcSub;

  // Fall back to local username lookup.
  const byUsername = await prisma.localUser.findUnique({
    where: { username: identifier },
    select: { userId: true },
  });
  return byUsername ? { id: byUsername.userId } : null;
}

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
  const uid = (req as AuthenticatedRequest).userId;
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
