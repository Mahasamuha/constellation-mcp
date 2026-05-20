import { Router, Request, Response, IRouter } from "express";
import { prisma } from "./db.js";
import { buildAuthorizationUrl, exchangeCodeAndUpsertUser } from "./oidc.js";
import { generateToken, hashToken, createLogger } from "@constellation/shared";

const log = createLogger("device");

export const deviceRouter: IRouter = Router();

// ---------------------------------------------------------------------------
// Device authorization state (in-memory, 15 min TTL)
// ---------------------------------------------------------------------------

export type DeviceScope = "agent:register" | "broker:manage";

interface DeviceEntry {
  userCode: string;
  scope: DeviceScope;
  expiresAt: number;
  /** Set once the user completes consent on /activate */
  status: "pending" | "approved" | "denied";
  userId?: string;
  /** Confirmed host name, set for agent:register scope */
  hostName?: string;
}

const deviceCodes = new Map<string, DeviceEntry>();

// Prune expired entries on each new issuance to avoid unbounded growth.
function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of deviceCodes) {
    if (v.expiresAt < now) deviceCodes.delete(k);
  }
}

function findByUserCode(userCode: string): [string, DeviceEntry] | undefined {
  const normalized = userCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const [deviceCode, entry] of deviceCodes) {
    if (entry.userCode.replace("-", "") === normalized) return [deviceCode, entry];
  }
  return undefined;
}

/** Generates a human-friendly 9-char user code in XXXX-XXXX format. */
function generateUserCode(): string {
  // Omit visually ambiguous characters: 0, O, 1, I, L
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  const half = () => Array.from({ length: 4 }, pick).join("");
  return `${half()}-${half()}`;
}

// ---------------------------------------------------------------------------
// POST /oauth/device/code
// ---------------------------------------------------------------------------

deviceRouter.post("/oauth/device/code", (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const scope = body["scope"] as DeviceScope | undefined;

  if (scope !== "agent:register" && scope !== "broker:manage") {
    res.status(400).json({ error: "invalid_scope", error_description: "scope must be agent:register or broker:manage" });
    return;
  }

  pruneExpired();

  const deviceCode = generateToken();
  const userCode = generateUserCode();
  const expiresIn = 15 * 60; // seconds

  deviceCodes.set(deviceCode, {
    userCode,
    scope,
    expiresAt: Date.now() + expiresIn * 1000,
    status: "pending",
  });

  const brokerUrl = requireEnv("BROKER_URL");

  log.info({ scope }, "Device code issued");

  res.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${brokerUrl}/activate`,
    verification_uri_complete: `${brokerUrl}/activate?user_code=${userCode}`,
    expires_in: expiresIn,
    interval: 5,
  });
});

// ---------------------------------------------------------------------------
// GET /activate — consent page (browser-facing)
// ---------------------------------------------------------------------------

// Pending activate sessions: maps a pendingId (embedded in OIDC state cookie)
// back to the device code being authorized.
interface ActivatePending {
  state: string;
  deviceCode: string;
}

const activatePending = new Map<string, ActivatePending>();

deviceRouter.get("/activate", async (req: Request, res: Response) => {
  const userCode = typeof req.query["user_code"] === "string" ? req.query["user_code"] : undefined;

  // If no code in query, show the entry form.
  if (!userCode) {
    res.send(activateEntryPage());
    return;
  }

  const match = findByUserCode(userCode);
  if (!match) {
    res.send(activateEntryPage("Invalid or expired code. Please try again."));
    return;
  }

  const [deviceCode, entry] = match;

  if (entry.status !== "pending" || entry.expiresAt < Date.now()) {
    res.send(activateEntryPage("This code has already been used or has expired."));
    return;
  }

  // Start OIDC flow. Store device context in cookie so callback can complete it.
  const callbackUrl = `${requireEnv("BROKER_URL")}/activate/callback`;
  const { url, state, codeVerifier } = await buildAuthorizationUrl(callbackUrl, false);

  const pendingId = generateToken().slice(0, 32);
  activatePending.set(pendingId, { state, deviceCode });

  res.cookie(`activate_pending_${pendingId}`, JSON.stringify({ state, codeVerifier, deviceCode }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    sameSite: "lax",
  });

  url.searchParams.set("state", `${state}:${pendingId}`);
  res.redirect(url.toString());
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

  let stored: { state: string; codeVerifier?: string; deviceCode: string };
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

  const callbackUrl = `${requireEnv("BROKER_URL")}/activate/callback?${new URLSearchParams(req.query as Record<string, string>).toString()}`;

  let userId: string;
  try {
    userId = await exchangeCodeAndUpsertUser(prisma, callbackUrl, upstreamState, stored.codeVerifier);
  } catch (err) {
    log.warn({ err }, "OIDC exchange failed on activate");
    res.status(400).send("Authentication failed. Please try again.");
    return;
  }

  const entry = deviceCodes.get(stored.deviceCode);
  if (!entry || entry.status !== "pending" || entry.expiresAt < Date.now()) {
    res.send(activateEntryPage("This code has already been used or has expired."));
    return;
  }

  // Show the consent form.
  res.send(consentPage(stored.deviceCode, entry.scope, userId));
});

// ---------------------------------------------------------------------------
// POST /activate/confirm — user submits consent form
// ---------------------------------------------------------------------------

deviceRouter.post("/activate/confirm", async (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  const { device_code, user_id, host_name, action } = body;

  if (action === "deny") {
    const entry = deviceCodes.get(device_code);
    if (entry) entry.status = "denied";
    res.send(activateDonePage("Access denied. You can close this tab."));
    return;
  }

  const entry = deviceCodes.get(device_code);
  if (!entry || entry.status !== "pending" || entry.expiresAt < Date.now()) {
    res.status(400).send("Session expired or already completed.");
    return;
  }

  if (entry.scope === "agent:register") {
    const resolvedHost = (host_name ?? "").trim();
    if (!resolvedHost) {
      res.send(consentPage(device_code, entry.scope, user_id, "Host name is required."));
      return;
    }
    // Check uniqueness for this user.
    const existing = await prisma.agent.findFirst({
      where: { userId: user_id, host: resolvedHost },
    });
    if (existing) {
      res.send(consentPage(device_code, entry.scope, user_id, `Host name "${resolvedHost}" is already registered.`));
      return;
    }
    entry.hostName = resolvedHost;
  }

  entry.userId = user_id;
  entry.status = "approved";

  log.info({ scope: entry.scope, userId: user_id }, "Device consent approved");
  res.send(activateDonePage("Access granted. You can close this tab."));
});

// ---------------------------------------------------------------------------
// device_code grant handler (called from oauth.ts token endpoint)
// ---------------------------------------------------------------------------

/**
 * Handles the device_code grant type. Issues an agent token (agent:register)
 * or an OAuth session (broker:manage) when the device entry is approved.
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

  const entry = deviceCodes.get(device_code);

  if (!entry) {
    res.status(400).json({ error: "invalid_grant", error_description: "device_code not found" });
    return;
  }

  if (entry.expiresAt < Date.now()) {
    deviceCodes.delete(device_code);
    res.status(400).json({ error: "expired_token" });
    return;
  }

  if (entry.status === "pending") {
    res.status(400).json({ error: "authorization_pending" });
    return;
  }

  if (entry.status === "denied") {
    deviceCodes.delete(device_code);
    res.status(400).json({ error: "access_denied" });
    return;
  }

  // Approved — consume the entry.
  deviceCodes.delete(device_code);
  const userId = entry.userId!;

  if (entry.scope === "agent:register") {
    const token = generateToken();
    const tokenHash = hashToken(token);

    const agentToken = await prisma.agentToken.create({
      data: { userId, tokenHash },
      select: { id: true },
    });

    await prisma.agent.create({
      data: {
        userId,
        agentTokenId: agentToken.id,
        host: entry.hostName!,
      },
    });

    log.info({ userId, host: entry.hostName }, "Agent registered via device flow");

    res.json({
      access_token: token,
      token_type: "agent",
      host: entry.hostName,
    });
  } else {
    // broker:manage — issue a standard OAuth session
    const accessToken = generateToken();
    const accessTokenHash = hashToken(accessToken);
    const refreshToken = generateToken();
    const refreshTokenHash = hashToken(refreshToken);

    const accessTtlHours = parseInt(process.env["OAUTH_ACCESS_TOKEN_TTL_HOURS"] ?? "24", 10);
    const refreshTtlDays = parseInt(process.env["OAUTH_REFRESH_TOKEN_TTL_DAYS"] ?? "30", 10);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + accessTtlHours * 3600 * 1000);
    const refreshExpiresAt = new Date(now.getTime() + refreshTtlDays * 86400 * 1000);

    // broker:manage uses a well-known static client id since it's first-party.
    const clientId = await ensureBrokerClient();

    await prisma.oauthSession.create({
      data: {
        userId,
        mcpClientId: clientId,
        accessTokenHash,
        expiresAt,
        refreshTokenHash,
        refreshTokenExpiresAt: refreshExpiresAt,
      },
    });

    log.info({ userId }, "Broker manage session issued via device flow");

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTtlHours * 3600,
      refresh_token: refreshToken,
    });
  }
}

/** Returns the id of the static broker-manage OAuth client, creating it on first call. */
async function ensureBrokerClient(): Promise<string> {
  const existing = await prisma.oauthClient.findFirst({
    where: { isDynamic: false, grantTypes: { has: "broker:manage" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.oauthClient.create({
    data: {
      redirectUris: [],
      grantTypes: ["broker:manage", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      isDynamic: false,
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

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
      <input id="user_code" name="user_code" type="text" placeholder="XXXX-XXXX" autocomplete="off" autofocus required>
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function consentPage(deviceCode: string, scope: DeviceScope, userId: string, error?: string): string {
  const isAgent = scope === "agent:register";
  const title = isAgent ? "Register Agent" : "Authorize Management Access";
  const description = isAgent
    ? "A <strong>Constellation agent</strong> is requesting access to connect to this broker."
    : "The <strong>Constellation CLI</strong> is requesting management access to this broker.";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — ${escHtml(title)}</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>${escHtml(title)}</h1>
    <p>${description}</p>
    ${error ? `<p class="error">${escHtml(error)}</p>` : ""}
    <form method="POST" action="/activate/confirm">
      <input type="hidden" name="device_code" value="${escHtml(deviceCode)}">
      <input type="hidden" name="user_id" value="${escHtml(userId)}">
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

function pageStyle(): string {
  return `<style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 4rem 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    h1 { margin-top: 0; font-size: 1.4rem; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 500; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1.1rem; border: 1px solid #ccc; border-radius: 4px; letter-spacing: .1em; }
    button { margin-top: 1.2rem; padding: .6rem 1.4rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; background: #2563eb; color: #fff; }
    button.secondary { background: #e5e7eb; color: #111; margin-left: .6rem; }
    .actions { display: flex; }
    .error { color: #dc2626; background: #fee2e2; padding: .6rem; border-radius: 4px; }
  </style>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}
