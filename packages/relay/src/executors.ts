import { Router, Request, Response, NextFunction, IRouter } from "express";
import { prisma } from "./db.js";
import { ExecutorTokenType } from "./generated/prisma/client.js";
import { requireBearerAuth, requireAdmin, sendMissingScopes, type AuthenticatedRequest } from "./middleware.js";
import { ADMIN_SCOPE, BASE_SCOPE, REGISTER_SCOPE } from "./request-user.js";
import { generateToken, hashToken, createLogger, clientIdFor, requireEnv } from "@constellation/shared";
import { Prisma } from "./generated/prisma/client.js";
import { getConnection } from "./registry.js";
import { cancelPendingRotation } from "./hub.js";
import { validateHostName } from "./host-name.js";

const log = createLogger("executors");

export const executorsRouter: IRouter = Router();

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

  // Only the client that matches the executor type may register one. Any `relay` token
  // would otherwise do, including one a third-party MCP client (e.g. Claude.ai) holds.
  const expectedClientId = clientIdFor(requireEnv("RELAY_URL"), type);
  const user = (req as AuthenticatedRequest).user;
  if (user.clientId !== expectedClientId) {
    res.status(403).json({
      error: "invalid_client",
      error_description: `Registering a ${type} requires a token issued to the Constellation ${type} client (${expectedClientId})`,
    });
    return;
  }

  // Registering is permanent until removed, so it needs its own fresh-sign-in scope; a hub
  // is shared across users and also needs admin. Ask for everything missing in one challenge.
  const required = type === "hub" ? [BASE_SCOPE, ADMIN_SCOPE, REGISTER_SCOPE] : [BASE_SCOPE, REGISTER_SCOPE];
  if (!required.every((s) => user.scopes.includes(s))) {
    sendMissingScopes(res, required, type === "hub" ? "Registering a hub needs the admin and register scopes" : "Registering a node needs the register scope");
    return;
  }

  // The group check for admin.
  if (type === "hub" && !(await passes(requireAdmin, req, res))) return;

  const validated = validateHostName(body["host"]);
  if ("error" in validated) {
    res.status(400).json({ error: "invalid_request", error_description: validated.error });
    return;
  }
  const host = validated.host;

  const userId = user.id;
  const token = generateToken();
  const tokenHash = hashToken(token);

  // Set when this registration replaced an executor's token, so its live connection (which
  // authenticated with the revoked token) can be dropped once the new token is committed.
  let replacedExecutorId: string | undefined;

  try {
    await prisma.$transaction(async (tx) => {
      // Serialize registrations of the same (owner, host): the find-then-create below is
      // otherwise a race, and the hub case has no unique index to catch it. ":" cannot
      // appear in a host name, so the key is unambiguous.
      const lockKey = `${type === "hub" ? "hub" : userId}:${host}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      if (type === "hub") {
        // Replace the existing hub executor for this host, revoking its token. A row whose
        // token was already revoked is reused too: a second user-less row for the host would
        // break executors_hub_host_key.
        const existing = await tx.executor.findFirst({
          where: { userId: null, host, executorToken: { tokenType: ExecutorTokenType.HUB } },
          select: { executorTokenId: true, id: true },
        });
        if (existing) {
          replacedExecutorId = existing.id;
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
        replacedExecutorId = existing.id;
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
  } catch (err) {
    // The partial unique indexes backstop the advisory lock.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      res.status(409).json({ error: "conflict", error_description: `Host name "${host}" is already registered` });
      return;
    }
    throw err;
  }

  // The old token is revoked, but an open socket stays authenticated until it drops.
  if (replacedExecutorId) {
    getConnection(replacedExecutorId)?.ws.terminate();
    await cancelPendingRotation(replacedExecutorId);
  }

  log.info({ userId, host, type }, type === "hub" ? "Hub registered" : "Executor registered");

  res.set("Cache-Control", "no-store");
  res.json({ access_token: token, token_type: "agent", host });
}

executorsRouter.post("/api/executors/register", requireBearerAuth, registerExecutor);
