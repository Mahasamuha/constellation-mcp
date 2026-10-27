import { Router, Request, Response, NextFunction, IRouter } from "express";
import { prisma } from "./db.js";
import { ExecutorTokenType } from "./generated/prisma/client.js";
import { requireBearerAuth, requireAdmin, type AuthenticatedRequest } from "./middleware.js";
import { generateToken, hashToken, createLogger } from "@constellation/shared";

const log = createLogger("executors");

export const executorsRouter: IRouter = Router();

/** Matches the cap enforced by update_host's RPC (hub.ts). Without it an approved request would
 * permanently store an arbitrarily long Executor.host that surfaces forever in
 * list_hosts, /api/executors and the activity log. */
const MAX_HOST_LENGTH = 63;

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

/** Runs an Express middleware inline. Resolves true if it called next(), false if it answered itself. */
async function passes(mw: Middleware, req: Request, res: Response): Promise<boolean> {
  let nextCalled = false;
  let nextError: unknown;
  await mw(req, res, (err?: unknown) => {
    if (err) nextError = err;
    else nextCalled = true;
  });
  if (nextError) throw nextError;
  return nextCalled;
}

/**
 * POST /api/executors/register — replaces the device-grant registration in the old
 * device.ts. The caller already holds an asterism access token (a node's has the base
 * scope; a hub's also needs `admin`); this mints the long-lived ExecutorToken the
 * executor then uses on /executor/connect.
 *
 * Body: { type: "node" | "hub", host }. Response: { access_token, token_type: "agent", host },
 * the same shape the old device grant returned.
 */
export async function registerExecutor(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = body["type"];
  if (type !== "node" && type !== "hub") {
    res.status(400).json({ error: "invalid_request", error_description: "type must be node or hub" });
    return;
  }

  // A hub is shared across users, so only an admin token may register one.
  if (type === "hub" && !(await passes(requireAdmin, req, res))) return;

  const host = typeof body["host"] === "string" ? body["host"].trim() : "";
  if (!host) {
    res.status(400).json({ error: "invalid_request", error_description: "host is required" });
    return;
  }
  if (host.length > MAX_HOST_LENGTH) {
    res.status(400).json({ error: "invalid_request", error_description: `host must be ${MAX_HOST_LENGTH} characters or fewer` });
    return;
  }

  const userId = (req as AuthenticatedRequest).user.id;
  const token = generateToken();
  const tokenHash = hashToken(token);

  await prisma.$transaction(async (tx) => {
    if (type === "hub") {
      // Revoke any existing active HUB token for this host.
      const existing = await tx.executor.findFirst({
        where: {
          userId: null,
          host,
          executorToken: { tokenType: ExecutorTokenType.HUB, revokedAt: null },
        },
        select: { executorTokenId: true, id: true },
      });
      if (existing) {
        await tx.executorToken.update({ where: { id: existing.executorTokenId }, data: { revokedAt: new Date() } });
      }

      const executorToken = await tx.executorToken.create({
        data: { userId: null, tokenType: ExecutorTokenType.HUB, tokenHash, approvedByUserId: userId },
        select: { id: true },
      });

      if (existing) {
        await tx.executor.update({
          where: { id: existing.id },
          data: { executorTokenId: executorToken.id, lastHeartbeatAt: null, lastDisconnectReason: null },
        });
      } else {
        await tx.executor.create({ data: { userId: null, executorTokenId: executorToken.id, host } });
      }
      return;
    }

    // The userId_host compound unique was replaced by partial unique indexes
    // (executors_user_id_host_key) which Prisma cannot express natively. Use
    // findFirst + create/update instead of upsert.
    const existing = await tx.executor.findFirst({
      where: { userId, host },
      select: { id: true, executorTokenId: true },
    });

    // Revoke the existing token if re-registering the same host.
    if (existing) {
      await tx.executorToken.update({ where: { id: existing.executorTokenId }, data: { revokedAt: new Date() } });
    }

    const executorToken = await tx.executorToken.create({
      data: { userId, tokenHash },
      select: { id: true },
    });

    if (existing) {
      await tx.executor.update({
        where: { id: existing.id },
        data: { executorTokenId: executorToken.id, lastHeartbeatAt: null, lastDisconnectReason: null },
      });
    } else {
      await tx.executor.create({ data: { userId, executorTokenId: executorToken.id, host } });
    }
  });

  log.info({ userId, host, type }, type === "hub" ? "Hub registered" : "Executor registered");

  res.set("Cache-Control", "no-store");
  res.json({ access_token: token, token_type: "agent", host });
}

executorsRouter.post("/api/executors/register", requireBearerAuth, registerExecutor);
