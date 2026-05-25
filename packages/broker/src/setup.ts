import { Router, Request, Response, NextFunction, IRouter } from "express";
import escHtml from "escape-html";
import { prisma } from "./db.js";
import { createLocalUser } from "./local-auth.js";
import { verifyCsrfToken } from "./middleware.js";
import { generateToken, createLogger } from "@constellation/shared";

const log = createLogger("setup");

export const setupRouter: IRouter = Router();

// Cached after first user is created so we avoid a DB query on every request.
let _setupDone = false;

export async function setupRequired(): Promise<boolean> {
  if (process.env["AUTH_MODE"] !== "local") return false;
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
  if (process.env["AUTH_MODE"] !== "local") {
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
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 60 * 1000,
  });
  res.send(setupFormPage([], csrfToken));
});

// ---------------------------------------------------------------------------
// POST /setup
// ---------------------------------------------------------------------------

setupRouter.post("/setup", async (req: Request, res: Response) => {
  if (process.env["AUTH_MODE"] !== "local") {
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
      secure: process.env.NODE_ENV === "production",
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
    const msg = err instanceof Error ? err.message : "Setup failed";
    rerender([msg]);
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
  const brokerUrl = process.env["BROKER_URL"] ?? "https://your-broker-url";
  const authMode = process.env["AUTH_MODE"] ?? "oidc";
  const uptime = Math.floor((Date.now() - startedAt) / 1000);

  const mcpSnippet = JSON.stringify(
    { mcpServers: { constellation: { type: "http", url: `${brokerUrl}/mcp` } } },
    null,
    2
  );

  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Constellation Broker</title>${pageStyle()}</head>
<body>
  <div class="card wide">
    <h1>Constellation Broker</h1>
    <p class="meta">Auth mode: <strong>${escHtml(authMode)}</strong> &nbsp;|&nbsp; Uptime: <strong>${formatUptime(uptime)}</strong></p>

    <h2>Connect an MCP client</h2>
    <p>Add this to your MCP client configuration:</p>
    <pre>${escHtml(mcpSnippet)}</pre>

    <h2>Connect an agent</h2>
    <p>On the machine you want to access, run:</p>
    <pre>constellation agent init --broker ${escHtml(brokerUrl)}</pre>

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
    ["BROKER_URL", process.env["BROKER_URL"]],
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
    <p>The broker is running in <code>AUTH_MODE=oidc</code>. Check the environment variables below:</p>
    <ul class="checklist">${rows}</ul>
    <p>Set all required variables and restart the broker.</p>
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
    <p>An account already exists. <a href="/">Go to broker home</a>.</p>
  </div>
</body>
</html>`;
}

function pageStyle(): string {
  return `<style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 4rem 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .card.wide { max-width: 640px; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 1.6rem; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 500; }
    .hint { font-weight: 400; font-size: .85em; color: #666; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    button { margin-top: 1.2rem; padding: .6rem 1.4rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; background: #2563eb; color: #fff; }
    pre { background: #f1f5f9; padding: 1rem; border-radius: 4px; font-size: .85rem; overflow-x: auto; white-space: pre-wrap; }
    .error { color: #dc2626; background: #fee2e2; padding: .4rem .6rem; border-radius: 4px; margin: 0; padding-left: 1.6rem; }
    .error li { padding: .2rem 0; }
    .meta { color: #555; font-size: .9rem; }
    .checklist { list-style: none; padding: 0; }
    .checklist li { padding: .3rem 0; }
    .checklist .ok { color: #16a34a; }
    .checklist .missing { color: #dc2626; }
  </style>`;
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
