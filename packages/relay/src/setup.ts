import { Router, Request, Response, NextFunction, IRouter } from "express";
import escHtml from "escape-html";
import { prisma } from "./db.js";
import { createLocalUser } from "./local-auth.js";
import { verifyCsrfToken } from "./middleware.js";
import { generateToken, createLogger } from "@constellation/shared";
import { pageStyle } from "./page-style.js";
import { config } from "./config.js";

const log = createLogger("setup");

export const setupRouter: IRouter = Router();

// Cached after first user is created so we avoid a DB query on every request.
let _setupDone = false;

export async function setupRequired(): Promise<boolean> {
  if (config.authMode !== "local") return false;
  if (_setupDone) return false;
  const count = await prisma.localUser.count();
  if (count > 0) {
    _setupDone = true;
    return false;
  }
  return true;
}

export function markSetupDone(): void {
  _setupDone = true;
}

/** Redirects to /setup when local auth is enabled and no users exist yet. */
export async function setupMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const skip = req.path === "/setup" || req.path === "/healthz" || req.path === "/api/status";
  if (skip) { next(); return; }

  if (await setupRequired()) {
    res.redirect("/setup");
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /setup
// ---------------------------------------------------------------------------

setupRouter.get("/setup", async (_req: Request, res: Response) => {
  if (config.authMode !== "local") {
    res.send(oidcSetupPage());
    return;
  }

  const done = !(await setupRequired());
  if (done) {
    res.status(410).send(gonePage());
    return;
  }

  const csrfToken = generateToken();
  res.cookie("csrf_setup", csrfToken, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    maxAge: 30 * 60 * 1000,
  });
  res.send(setupFormPage([], csrfToken));
});

// ---------------------------------------------------------------------------
// POST /setup
// ---------------------------------------------------------------------------

setupRouter.post("/setup", async (req: Request, res: Response) => {
  if (config.authMode !== "local") {
    res.status(405).end();
    return;
  }

  if (!(await setupRequired())) {
    res.status(410).send(gonePage());
    return;
  }

  const body = req.body as Record<string, string>;
  if (!verifyCsrfToken(req, "csrf_setup")) {
    res.status(403).send(setupFormPage(["Invalid or missing CSRF token. Please reload and try again."]));
    return;
  }

  // Re-render the form with a fresh CSRF token so validation errors don't lock the user out.
  function rerender(errors: string[]): void {
    const newToken = generateToken();
    res.cookie("csrf_setup", newToken, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "strict",
      maxAge: 30 * 60 * 1000,
    });
    res.send(setupFormPage(errors, newToken));
  }

  const username = (body["username"] ?? "").trim();
  const password = body["password"] ?? "";
  const confirm = body["confirm_password"] ?? "";

  const errors: string[] = [];
  if (!username) errors.push("Username is required.");
  if (password.length < 12) errors.push("Password must be at least 12 characters.");
  if (password !== confirm) errors.push("Passwords do not match.");
  if (errors.length > 0) {
    rerender(errors);
    return;
  }

  try {
    await createLocalUser(username, password);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.toLowerCase().includes("unique")) {
      rerender(["Username already taken."]);
    } else {
      // This route is reachable unauthenticated (gated only by setupRequired()'s
      // one-time race), so a raw DB/driver error must never reach the response —
      // log it server-side only, same pattern as api.ts's user-creation route.
      log.error({ err, username }, "Failed to create first user via setup");
      rerender(["Setup failed. Please try again or contact your administrator."]);
    }
    return;
  }

  res.clearCookie("csrf_setup");
  markSetupDone();
  log.info({ username }, "First user created via setup");
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

setupRouter.get("/", async (_req: Request, res: Response) => {
  const relayUrl = process.env["RELAY_URL"] ?? "https://your-relay-url";
  const authMode = config.authMode;
  const uptime = Math.floor((Date.now() - startedAt) / 1000);

  const mcpSnippet = JSON.stringify(
    { mcpServers: { constellation: { type: "http", url: `${relayUrl}/mcp` } } },
    null,
    2
  );

  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation Relay</title>${pageStyle()}</head>
<body>
  <div class="card wide">
    <h1>Constellation Relay</h1>
    <p class="meta">Auth mode: <strong>${escHtml(authMode)}</strong> &nbsp;|&nbsp; Uptime: <strong>${formatUptime(uptime)}</strong></p>

    <h2>Connect an MCP client</h2>
    <p>Add this to your MCP client configuration:</p>
    <pre>${escHtml(mcpSnippet)}</pre>

    <h2>Connect a node</h2>
    <p>On the machine you want to access, run:</p>
    <pre>constellation node init --relay ${escHtml(relayUrl)}</pre>

    ${authMode === "local" ? `<p><a href="/activate">Activate a device</a></p>` : ""}
  </div>
</body>
</html>`);
});

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function setupFormPage(errors: string[], csrfToken?: string): string {
  const errorHtml = errors.length > 0
    ? `<ul class="error">${errors.map((e) => `<li>${escHtml(e)}</li>`).join("")}</ul>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — Setup</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>Welcome to Constellation</h1>
    <p>Create your admin account to get started.</p>
    ${errorHtml}
    <form method="POST" action="/setup">
      ${csrfToken ? `<input type="hidden" name="csrf_token" value="${escHtml(csrfToken)}">` : ""}
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autofocus required>
      <label for="password">Password <span class="hint">(min 12 characters)</span></label>
      <input id="password" name="password" type="password" autocomplete="new-password" required minlength="12">
      <label for="confirm_password">Confirm password</label>
      <input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" required>
      <button type="submit">Create account</button>
    </form>
  </div>
</body>
</html>`;
}

function oidcSetupPage(): string {
  const checks = [
    ["OIDC_ISSUER", process.env["OIDC_ISSUER"]],
    ["OIDC_CLIENT_ID", process.env["OIDC_CLIENT_ID"]],
    ["OIDC_CLIENT_SECRET", process.env["OIDC_CLIENT_SECRET"]],
    ["RELAY_URL", process.env["RELAY_URL"]],
  ];

  const rows = checks.map(([name, val]) =>
    `<li class="${val ? "ok" : "missing"}">${val ? "✓" : "✗"} <code>${escHtml(name!)}</code>${val ? "" : " — not set"}</li>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation — OIDC Setup</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>OIDC Configuration</h1>
    <p>The relay is running in <code>AUTH_MODE=oidc</code>. Check the environment variables below:</p>
    <ul class="checklist">${rows}</ul>
    <p>Set all required variables and restart the relay.</p>
  </div>
</body>
</html>`;
}

function gonePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation</title>${pageStyle()}</head>
<body>
  <div class="card">
    <h1>Setup complete</h1>
    <p>An account already exists. <a href="/">Go to relay home</a>.</p>
  </div>
</body>
</html>`;
}


function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
