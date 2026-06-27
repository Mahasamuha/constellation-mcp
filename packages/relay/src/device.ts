import { Router, Request, Response, IRouter } from "express";
import escHtml from "escape-html";
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";
import { ExecutorTokenType, RelayRole, Prisma } from "./generated/prisma/client.js";
import { buildAuthorizationUrl, exchangeCodeAndUpsertUser } from "./oidc.js";
import { issueOAuthSession, sendTokenResponse } from "./oauth-tokens.js";
import { generateToken, hashToken, createLogger, requireEnv } from "@constellation/shared";
import { checkBruteForce, recordFailure, validateLocalUser } from "./local-auth.js";
import { verifyCsrfToken } from "./middleware.js";
import { pageStyle } from "./page-style.js";
import { config } from "./config.js";

const log = createLogger("device");

export const deviceRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// Device authorization state (in-memory, 15 min TTL)
// ---------------------------------------------------------------------------

export type DeviceScope = "agent:register" | "relay:manage" | "agent:escalate" | "agent:register:shared";

/**
 * Single source of truth for "does this user hold the ADMIN role" — used by every
 * consent-flow scope that requires admin approval (agent:escalate,
 * agent:register:shared), so a future admin-gated scope reuses this check instead of
 * re-deriving it inline and risking a copy-paste mistake.
 */
async function isAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role === RelayRole.ADMIN;
}

/**
 * Forces every DeviceScope dispatch (consent approval, grant issuance) to be an
 * exhaustive switch: TypeScript only allows passing a `never`-typed value here, which
 * only holds if every member of the DeviceScope union already has its own `case`. A
 * scope added to the union without a corresponding case fails to compile, instead of
 * silently falling into whichever dispatch's `default`/`else` branch happened to be
 * the most permissive.
 */
function unhandledScope(scope: never): never {
  throw new Error(`Unhandled DeviceScope: ${String(scope)}`);
}

/** Removes expired device code rows. Called on new issuance and periodically from index.ts. */
export async function pruneDeviceCodes(): Promise<void> {
  await prisma.deviceCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

function normalizeUserCode(userCode: string): string {
  return userCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function findByUserCode(userCode: string) {
  return prisma.deviceCode.findFirst({
    where: { userCode: normalizeUserCode(userCode), status: "pending", expiresAt: { gt: new Date() } },
  });
}

/** Looks up a device code row by the raw (unhashed) device_code presented by the polling device. */
function byCode(deviceCode: string) {
  return { where: { deviceCodeHash: hashToken(deviceCode) } } as const;
}

/** Generates a human-friendly 8-char normalized user code (no dash). Caller formats for display. */
function generateUserCode(): string {
  // Omit visually ambiguous characters: 0, O, 1, I, L
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const pick = (b: number) => chars[b % chars.length]!;
  return [0, 1, 2, 3, 4, 5, 6, 7].map(i => pick(bytes[i]!)).join("");
}

// ---------------------------------------------------------------------------
// POST /oauth/device/code
// ---------------------------------------------------------------------------

deviceRouter.post("/oauth/device/code", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const scope = body["scope"] as DeviceScope | undefined;

  if (scope !== "agent:register" && scope !== "relay:manage" && scope !== "agent:escalate" && scope !== "agent:register:shared") {
    res.status(400).json({ error: "invalid_scope", error_description: "scope must be agent:register, relay:manage, agent:escalate, or agent:register:shared" });
    return;
  }

  // For agent:escalate, the caller must provide the session ID to elevate.
  const elevateSessionId = scope === "agent:escalate"
    ? (typeof body["elevate_session_id"] === "string" ? body["elevate_session_id"].trim() : "")
    : undefined;

  if (scope === "agent:escalate" && !elevateSessionId) {
    res.status(400).json({ error: "invalid_request", error_description: "elevate_session_id is required for agent:escalate scope" });
    return;
  }

  // For agent:register:shared, the agent provides host_name upfront (not entered in browser).
  const sharedHostName = scope === "agent:register:shared"
    ? (typeof body["host_name"] === "string" ? body["host_name"].trim() : "")
    : undefined;

  if (scope === "agent:register:shared" && !sharedHostName) {
    res.status(400).json({ error: "invalid_request", error_description: "host_name is required for agent:register:shared scope" });
    return;
  }

  // Matches the cap enforced on agent:register's consent-page host_name (below) and
  // update_host's RPC (hub.ts) — this endpoint is unauthenticated, so without a cap an
  // approved request would permanently store an arbitrarily long (up to the 1MB body
  // limit) Executor.host that surfaces forever in list_hosts/api/executors/the activity log.
  if (scope === "agent:register:shared" && sharedHostName && sharedHostName.length > 63) {
    res.status(400).json({ error: "invalid_request", error_description: "host_name must be 63 characters or fewer" });
    return;
  }

  await pruneDeviceCodes();

  const deviceCode = generateToken();
  const userCodeNormalized = generateUserCode();
  const userCodeDisplay = `${userCodeNormalized.slice(0, 4)}-${userCodeNormalized.slice(4)}`;
  const expiresIn = 15 * 60; // seconds

  await prisma.deviceCode.create({
    data: {
      deviceCodeHash: hashToken(deviceCode),
      userCode: userCodeNormalized,
      scope,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      ...(elevateSessionId ? { elevateSessionId } : {}),
      ...(sharedHostName ? { hostName: sharedHostName } : {}),
    },
  });

  const relayUrl = requireEnv("RELAY_URL");

  log.info({ scope }, "Device code issued");

  res.set("Cache-Control", "no-store");
  res.json({
    device_code: deviceCode,
    user_code: userCodeDisplay,
    verification_uri: `${relayUrl}/activate`,
    verification_uri_complete: `${relayUrl}/activate?user_code=${userCodeDisplay}`,
    expires_in: expiresIn,
    interval: 5,
  });
});

// ---------------------------------------------------------------------------
// GET /activate — consent page (browser-facing)
// ---------------------------------------------------------------------------

deviceRouter.get("/activate", async (req: Request, res: Response) => {
  const userCode = typeof req.query["user_code"] === "string" ? req.query["user_code"] : undefined;

  if (!userCode) {
    res.send(activateEntryPage());
    return;
  }

  const entry = await findByUserCode(userCode);
  if (!entry) {
    res.send(activateEntryPage("Invalid or expired code. Please try again."));
    return;
  }

  if (config.authMode === "local") {
    res.send(localActivateLoginPage(entry.userCode));
    return;
  }

  // OIDC mode: start OIDC flow and store device context in cookie.
  const callbackUrl = `${requireEnv("RELAY_URL")}/activate/callback`;
  const { url, state, codeVerifier } = await buildAuthorizationUrl(callbackUrl, false);

  const pendingId = generateToken().slice(0, 32);

  // Only the (low-stakes, human-typed) user_code rides through the browser session from
  // here on — the actual device_code bearer secret never needs to leave the polling device.
  res.cookie(`activate_pending_${pendingId}`, JSON.stringify({ state, codeVerifier, userCode: entry.userCode }), {
    httpOnly: true,
    secure: config.secureCookies,
    maxAge: 10 * 60 * 1000,
    sameSite: "lax",
  });

  url.searchParams.set("state", `${state}:${pendingId}`);
  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// POST /activate/login — local auth credential validation for device flow
// ---------------------------------------------------------------------------

deviceRouter.post("/activate/login", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const userCode = (body["user_code"] ?? "").trim();
  const username = (body["username"] ?? "").trim();
  const password = body["password"] ?? "";

  const ip = req.ip ?? "unknown";
  if (!await checkBruteForce(ip)) {
    res.status(429).send(localActivateLoginPage(userCode, "Too many failed attempts. Please wait 15 minutes."));
    return;
  }

  const entry = await findByUserCode(userCode);
  if (!entry) {
    res.send(activateEntryPage("This code has already been used or has expired."));
    return;
  }

  let userId: string;
  try {
    userId = await validateLocalUser(username, password);
  } catch {
    await recordFailure(ip);
    res.send(localActivateLoginPage(userCode, "Invalid username or password."));
    return;
  }

  await prisma.deviceCode.update({ where: { deviceCodeHash: entry.deviceCodeHash }, data: { pendingUserId: userId } });
  const csrfToken = generateToken();
  res.cookie("csrf_activate", csrfToken, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  });
  res.send(consentPage(entry.userCode, entry.scope as DeviceScope, entry.hostName, undefined, csrfToken));
});

// ---------------------------------------------------------------------------
// GET /activate/callback — OIDC return for device consent
// ---------------------------------------------------------------------------

deviceRouter.get("/activate/callback", async (req: Request, res: Response) => {
  const rawState = typeof req.query["state"] === "string" ? req.query["state"] : "";
  const colonIdx = rawState.lastIndexOf(":");
  if (colonIdx === -1) {
    res.status(400).send("Invalid state");
    return;
  }

  const upstreamState = rawState.slice(0, colonIdx);
  const pendingId = rawState.slice(colonIdx + 1);
  const cookieName = `activate_pending_${pendingId}`;
  const cookieVal = (req.cookies as Record<string, string>)[cookieName];

  if (!cookieVal) {
    res.status(400).send("Session expired. Please start again.");
    return;
  }

  res.clearCookie(cookieName);

  let stored: { state: string; codeVerifier?: string; userCode: string };
  try {
    stored = JSON.parse(cookieVal) as typeof stored;
  } catch {
    res.status(400).send("Malformed session");
    return;
  }

  if (stored.state !== upstreamState) {
    res.status(400).send("State mismatch");
    return;
  }

  const callbackUrl = `${requireEnv("RELAY_URL")}/activate/callback?${new URLSearchParams(req.query as Record<string, string>).toString()}`;

  let userId: string;
  try {
    // Pass rawState (the full composite value) as expectedState so openid-client's
    // internal check matches the state in the callback URL. Our own state integrity
    // check (stored.state === upstreamState) above already verified authenticity.
    userId = await exchangeCodeAndUpsertUser(prisma, callbackUrl, rawState, stored.codeVerifier);
  } catch (err) {
    log.warn({ err }, "OIDC exchange failed on activate");
    res.status(400).send("Authentication failed. Please try again.");
    return;
  }

  const entry = await findByUserCode(stored.userCode);
  if (!entry) {
    res.send(activateEntryPage("This code has already been used or has expired."));
    return;
  }

  // Store the OIDC-verified userId server-side before showing the consent page.
  await prisma.deviceCode.update({ where: { deviceCodeHash: entry.deviceCodeHash }, data: { pendingUserId: userId } });

  const csrfToken = generateToken();
  res.cookie("csrf_activate", csrfToken, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
  });
  res.send(consentPage(entry.userCode, entry.scope as DeviceScope, entry.hostName, undefined, csrfToken));
});

// ---------------------------------------------------------------------------
// POST /activate/confirm — user submits consent form
// ---------------------------------------------------------------------------

deviceRouter.post("/activate/confirm", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const { user_code, host_name, action } = body;

  if (!verifyCsrfToken(req, "csrf_activate")) {
    res.status(403).send("Invalid or missing CSRF token. Please go back and try again.");
    return;
  }

  const normalizedUserCode = normalizeUserCode(user_code ?? "");

  if (action === "deny") {
    res.clearCookie("csrf_activate");
    await prisma.deviceCode.updateMany({
      where: { userCode: normalizedUserCode, status: "pending" },
      data: { status: "denied" },
    });
    res.send(activateDonePage("Access denied. You can close this tab."));
    return;
  }

  if (action !== "approve") {
    res.clearCookie("csrf_activate");
    res.status(400).send("Invalid action.");
    return;
  }

  const entry = await findByUserCode(normalizedUserCode);
  if (!entry) {
    res.clearCookie("csrf_activate");
    res.status(400).send("Session expired or already completed.");
    return;
  }
  const byEntry = { where: { deviceCodeHash: entry.deviceCodeHash } } as const;

  // Use the server-side verified userId set during OIDC — never trust the form body.
  const verifiedUserId = entry.pendingUserId;
  if (!verifiedUserId) {
    res.clearCookie("csrf_activate");
    res.status(400).send("Authentication session expired — please start again.");
    return;
  }

  const scope = entry.scope as DeviceScope;
  switch (scope) {
    case "agent:register": {
      const resolvedHost = (host_name ?? "").trim();
      if (!resolvedHost || resolvedHost.length > 63) {
        const errorMsg = !resolvedHost ? "Host name is required." : "Host name must be 63 characters or fewer.";
        const freshCsrf = generateToken();
        res.cookie("csrf_activate", freshCsrf, {
          httpOnly: true,
          secure: config.secureCookies,
          sameSite: "strict",
          maxAge: 15 * 60 * 1000,
        });
        res.send(consentPage(entry.userCode, scope, entry.hostName, errorMsg, freshCsrf));
        return;
      }
      await prisma.deviceCode.update({ ...byEntry, data: { hostName: resolvedHost, userId: verifiedUserId, status: "approved" } });
      break;
    }
    case "agent:escalate": {
      // Role check: must be ADMIN — never reveal whether the user lacks the role.
      if (!(await isAdmin(verifiedUserId))) {
        res.clearCookie("csrf_activate");
        // Deny silently — same UX as a normal deny, no oracle about role status.
        await prisma.deviceCode.update({ ...byEntry, data: { status: "denied" } });
        res.send(activateDonePage("Access denied. You can close this tab."));
        return;
      }
      // Verify the target session belongs to the approving user before elevating.
      const targetSession = entry.elevateSessionId
        ? await prisma.oauthSession.findFirst({
            where: { id: entry.elevateSessionId, userId: verifiedUserId },
            select: { id: true },
          })
        : null;
      if (!targetSession) {
        res.clearCookie("csrf_activate");
        await prisma.deviceCode.update({ ...byEntry, data: { status: "denied" } });
        res.send(activateDonePage("Access denied. You can close this tab."));
        return;
      }
      await prisma.deviceCode.update({ ...byEntry, data: { userId: verifiedUserId, status: "approved" } });
      break;
    }
    case "agent:register:shared": {
      // Role check: ADMIN only — never reveal whether the user lacks the role.
      if (!(await isAdmin(verifiedUserId))) {
        res.clearCookie("csrf_activate");
        await prisma.deviceCode.update({ ...byEntry, data: { status: "denied" } });
        res.send(activateDonePage("Access denied. You can close this tab."));
        return;
      }
      // Record the approving admin's userId for audit trail.
      await prisma.deviceCode.update({ ...byEntry, data: { userId: verifiedUserId, status: "approved" } });
      break;
    }
    case "relay:manage": {
      await prisma.deviceCode.update({ ...byEntry, data: { userId: verifiedUserId, status: "approved" } });
      break;
    }
    default:
      unhandledScope(scope);
  }

  res.clearCookie("csrf_activate");
  log.info({ scope: entry.scope, userId: verifiedUserId }, "Device consent approved");
  res.send(activateDonePage("Access granted. You can close this tab."));
});

// ---------------------------------------------------------------------------
// device_code grant handler (called from oauth.ts token endpoint)
// ---------------------------------------------------------------------------

/**
 * Handles the device_code grant type. Issues an agent token (agent:register)
 * or an OAuth session (relay:manage scope) when the device entry is approved.
 */
export async function handleDeviceCodeGrant(
  body: Record<string, string>,
  res: Response
): Promise<void> {
  const { device_code } = body;

  if (!device_code) {
    res.status(400).json({ error: "invalid_request", error_description: "device_code is required" });
    return;
  }

  const entry = await prisma.deviceCode.findUnique(byCode(device_code));

  if (!entry) {
    res.status(400).json({ error: "invalid_grant", error_description: "device_code not found" });
    return;
  }

  if (entry.expiresAt < new Date()) {
    await prisma.deviceCode.delete(byCode(device_code));
    res.status(400).json({ error: "expired_token" });
    return;
  }

  if (entry.status === "pending") {
    res.status(400).json({ error: "authorization_pending" });
    return;
  }

  if (entry.status === "denied") {
    await prisma.deviceCode.delete(byCode(device_code));
    res.status(400).json({ error: "access_denied" });
    return;
  }

  // Guard before consuming — an approved entry must have a userId set at approval time.
  const userId = entry.userId;
  if (!userId) {
    log.error({ deviceCodeHash: entry.deviceCodeHash }, "Approved device code missing userId — possible data corruption");
    res.status(500).json({ error: "server_error" });
    return;
  }

  // Consume the entry.
  try {
    await prisma.deviceCode.delete(byCode(device_code));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      res.status(400).json({ error: "invalid_grant", error_description: "Device code already redeemed" });
      return;
    }
    throw err;
  }

  const scope = entry.scope as DeviceScope;
  switch (scope) {
    case "agent:escalate": {
      // Role was checked at approval time, but that can be minutes stale by redemption
      // (bounded by the device code's 15-min TTL) — re-check here so a same-window
      // demotion doesn't still grant admin off the stale approval.
      if (!(await isAdmin(userId))) {
        res.status(400).json({ error: "access_denied", error_description: "Approving user no longer has admin privileges" });
        return;
      }
      // Set adminUntil on the target session. The target session was verified at
      // approval time; re-verify here that it still belongs to the same user.
      const targetSessionId = entry.elevateSessionId;
      if (!targetSessionId) {
        log.error({ deviceCodeHash: entry.deviceCodeHash }, "agent:escalate entry missing elevateSessionId");
        res.status(500).json({ error: "server_error" });
        return;
      }
      const targetSession = await prisma.oauthSession.findFirst({
        where: { id: targetSessionId, userId },
        select: { id: true, expiresAt: true },
      });
      if (!targetSession || targetSession.expiresAt < new Date()) {
        res.status(400).json({ error: "access_denied", error_description: "Target session is no longer valid" });
        return;
      }
      const adminUntil = new Date(Date.now() + config.adminSessionDurationMs);
      await prisma.oauthSession.update({
        where: { id: targetSessionId },
        data: { adminUntil },
      });
      log.info({ userId, targetSessionId, adminUntil }, "Session elevated to admin");
      res.status(204).end();
      return;
    }
    case "agent:register:shared": {
      // Same staleness window as agent:escalate above — re-check admin role here too.
      if (!(await isAdmin(userId))) {
        res.status(400).json({ error: "access_denied", error_description: "Approving user no longer has admin privileges" });
        return;
      }
      const token = generateToken();
      const tokenHash = hashToken(token);

      await prisma.$transaction(async (tx) => {
        // Revoke any existing active HUB token for this host.
        const existingExecutor = await tx.executor.findFirst({
          where: {
            userId: null,
            host: entry.hostName!,
            executorToken: { tokenType: ExecutorTokenType.HUB, revokedAt: null },
          },
          select: { executorTokenId: true, id: true },
        });
        if (existingExecutor) {
          await tx.executorToken.update({
            where: { id: existingExecutor.executorTokenId },
            data: { revokedAt: new Date() },
          });
        }

        const executorToken = await tx.executorToken.create({
          data: {
            userId: null,
            tokenType: ExecutorTokenType.HUB,
            tokenHash,
            approvedByUserId: userId,
          },
          select: { id: true },
        });

        if (existingExecutor) {
          await tx.executor.update({
            where: { id: existingExecutor.id },
            data: { executorTokenId: executorToken.id, lastHeartbeatAt: null, lastDisconnectReason: null },
          });
        } else {
          await tx.executor.create({
            data: { userId: null, executorTokenId: executorToken.id, host: entry.hostName! },
          });
        }
      });

      log.info({ approvedByUserId: userId, host: entry.hostName }, "Hub registered via device flow");

      res.json({
        access_token: token,
        token_type: "agent",
        host: entry.hostName,
      });
      return;
    }
    case "agent:register": {
      const token = generateToken();
      const tokenHash = hashToken(token);

      await prisma.$transaction(async (tx) => {
        // The userId_host compound unique was replaced by partial unique indexes
        // (executors_user_id_host_key) which Prisma cannot express natively. Use
        // findFirst + create/update instead of upsert.
        const existingExecutor = await tx.executor.findFirst({
          where: { userId, host: entry.hostName! },
          select: { id: true, executorTokenId: true },
        });

        // Revoke the existing token if re-registering the same host.
        if (existingExecutor) {
          await tx.executorToken.update({
            where: { id: existingExecutor.executorTokenId },
            data: { revokedAt: new Date() },
          });
        }

        const executorToken = await tx.executorToken.create({
          data: { userId, tokenHash },
          select: { id: true },
        });

        if (existingExecutor) {
          await tx.executor.update({
            where: { id: existingExecutor.id },
            data: { executorTokenId: executorToken.id, lastHeartbeatAt: null, lastDisconnectReason: null },
          });
        } else {
          await tx.executor.create({
            data: { userId, executorTokenId: executorToken.id, host: entry.hostName! },
          });
        }
      });

      log.info({ userId, host: entry.hostName }, "Executor registered via device flow");

      res.json({
        access_token: token,
        token_type: "agent",
        host: entry.hostName,
      });
      return;
    }
    case "relay:manage": {
      const clientId = await ensureRelayClient();
      const tokens = await issueOAuthSession(userId, clientId);

      log.info({ userId }, "CLI session issued via device flow");
      sendTokenResponse(res, tokens);
      return;
    }
    default:
      unhandledScope(scope);
  }
}

const RELAY_CLIENT_ID = "constellation-cli";
let _relayClientEnsured = false;

/** Returns the id of the static CLI OAuth client, creating it if absent. */
async function ensureRelayClient(): Promise<string> {
  if (!_relayClientEnsured) {
    await prisma.oauthClient.upsert({
      where: { id: RELAY_CLIENT_ID },
      create: {
        id: RELAY_CLIENT_ID,
        redirectUris: [],
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        isDynamic: false,
      },
      update: {},
    });
    _relayClientEnsured = true;
  }
  return RELAY_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function localActivateLoginPage(userCode: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Sign in</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>Sign in to activate</h1>
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="POST" action="/activate/login">
      <input type="hidden" name="user_code" value="${escHtml(userCode)}">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

function activateEntryPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Activate</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>Activate Device</h1>
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="GET" action="/activate">
      <label for="user_code">Enter the code displayed in your terminal:</label>
      <input id="user_code" name="user_code" type="text" class="code-input" placeholder="XXXX-XXXX" autocomplete="off" autofocus required>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function consentPage(userCode: string, scope: DeviceScope, hostName: string | null | undefined, error?: string, csrfToken?: string): string {
  const isAgent = scope === "agent:register";
  const isEscalate = scope === "agent:escalate";
  const isHubRegistration = scope === "agent:register:shared";
  const title = isAgent ? "Register Node"
    : isEscalate ? "Authorize Admin Escalation"
    : isHubRegistration ? "Register Hub"
    : "Authorize Management Access";
  const description = isAgent
    ? "A <strong>Constellation node</strong> is requesting access to connect to this relay."
    : isEscalate
      ? "The <strong>Constellation CLI</strong> is requesting temporary admin access. This elevates your session for a limited time window."
      : isHubRegistration
        ? `A <strong>Constellation hub</strong> on host <strong>${escHtml(hostName ?? "unknown")}</strong> is requesting registration. Approving will allow this hub to handle file access requests on behalf of multiple users. <strong>This requires admin privileges.</strong>`
        : "The <strong>Constellation CLI</strong> is requesting management access to this relay.";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — ${escHtml(title)}</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>${escHtml(title)}</h1>
    <p>${description}</p>
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="POST" action="/activate/confirm">
      <input type="hidden" name="user_code" value="${escHtml(userCode)}">
      ${csrfToken ? `<input type="hidden" name="csrf_token" value="${escHtml(csrfToken)}">` : ""}
      ${isAgent ? `
      <label for="host_name">Host name for this machine:</label>
      <input id="host_name" name="host_name" type="text" placeholder="e.g. home-server" autocomplete="off" autofocus required>
      ` : ""}
      <div class="actions">
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny" class="secondary">Deny</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function activateDonePage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>Done</h1>
    <p>${escHtml(message)}</p>
  </div>
</body>
</html>`;
}

