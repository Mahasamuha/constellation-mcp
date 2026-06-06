import { Command } from "commander";
import open from "open";
import {
  loadAgentConfig,
  loadBrokerSession,
  writeBrokerSession,
  deleteBrokerSession,
  type BrokerSession,
} from "../config.js";
import { poll, confirm } from "./util.js";

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface AgentEntry {
  id: string;
  host: string;
  online: boolean;
  last_heartbeat_at: string | null;
  labels: Array<{ label: string; reported_path: string }>;
}

interface LabelEntry {
  label: string;
  host: string;
  reported_path: string;
}

interface FilterEntry {
  id: string;
  pattern: string;
  pattern_type: string;
  scope_agent_id: string | null;
  created_at: string;
}

interface SessionEntry {
  id: string;
  mcp_client_id: string;
  issued_at: string;
  expires_at: string;
  has_refresh_token: boolean;
}

// ---------------------------------------------------------------------------
// Broker URL resolution
// ---------------------------------------------------------------------------

function resolveBrokerUrl(flagUrl: string | undefined, getConfigDir: () => string): string {
  if (flagUrl) return flagUrl;
  try {
    return loadAgentConfig(getConfigDir()).broker_url;
  } catch {
    console.error(
      "No broker URL configured. Pass --broker <url> or run constellation agent init first."
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Session management with silent refresh
// ---------------------------------------------------------------------------

async function getValidSession(getConfigDir: () => string): Promise<BrokerSession> {
  const dir = getConfigDir();
  let session: BrokerSession;

  try {
    session = loadBrokerSession(dir);
  } catch {
    console.error("Not logged in. Run 'constellation broker login' first.");
    process.exit(1);
  }

  const expiresAt = new Date(session.access_token_expires_at);
  if (expiresAt > new Date()) return session;

  // Try silent refresh.
  if (session.refresh_token) {
    const refreshed = await tryRefresh(session);
    if (refreshed) {
      writeBrokerSession(dir, refreshed);
      return refreshed;
    }
  }

  console.error("Session expired. Run 'constellation broker login' to re-authenticate.");
  process.exit(1);
}

async function tryRefresh(session: BrokerSession): Promise<BrokerSession | null> {
  if (!session.refresh_token) return null;

  const res = await fetch(`${session.broker_url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      client_id: "constellation-cli",
    }),
  });

  if (!res.ok) return null;

  const body = await res.json() as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const now = new Date();
  const refreshTtlDays = 30;
  return {
    broker_url: session.broker_url,
    access_token: body.access_token,
    access_token_expires_at: new Date(now.getTime() + body.expires_in * 1000).toISOString(),
    refresh_token: body.refresh_token ?? session.refresh_token,
    refresh_token_expires_at: body.refresh_token
      ? new Date(now.getTime() + refreshTtlDays * 86400 * 1000).toISOString()
      : session.refresh_token_expires_at,
  };
}

// ---------------------------------------------------------------------------
// Authenticated fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(
  session: BrokerSession,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${session.broker_url}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
}

async function apiGet<T>(session: BrokerSession, path: string): Promise<T> {
  const res = await apiFetch(session, path);
  if (!res.ok) die(res);
  return res.json() as Promise<T>;
}

async function apiDelete(session: BrokerSession, path: string): Promise<void> {
  const res = await apiFetch(session, path, { method: "DELETE" });
  if (!res.ok) die(res);
}

async function apiPost<T>(
  session: BrokerSession,
  path: string,
  body: unknown
): Promise<T> {
  const res = await apiFetch(session, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) die(res);
  return res.json() as Promise<T>;
}

function die(res: Response): never {
  res.text().then((t) => console.error(`API error ${res.status}: ${t}`)).catch(() => {});
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Register all broker commands
// ---------------------------------------------------------------------------

export function registerBrokerCommands(program: Command, getConfigDir: () => string): void {
  // Capture as a local const so Commander action callbacks don't confuse it with an arg.
  const cfgDir = getConfigDir;

  const broker = program
    .command("broker")
    .description("Manage the remote Constellation broker")
    .option("--broker <url>", "Override broker URL");

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  broker
    .command("login")
    .description("Authenticate with the broker (OAuth device flow)")
    .option("--broker <url>", "Broker URL")
    .action(async (opts: { broker?: string }, cmd: Command) => {
      const brokerUrl = resolveBrokerUrl(
        opts.broker ?? (cmd.parent?.opts() as { broker?: string }).broker,
        getConfigDir
      );

      const dcRes = await fetch(`${brokerUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ scope: "broker:manage" }),
      });
      if (!dcRes.ok) {
        console.error("Failed to start device flow:", await dcRes.text());
        process.exit(1);
      }
      const dc = await dcRes.json() as {
        device_code: string;
        user_code: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };

      console.log(`\nOpen the following URL to authenticate (opening browser automatically):`);
      console.log(`  ${dc.verification_uri_complete}\n`);
      console.log(`If the browser did not open, enter this code: ${dc.user_code}\n`);
      try { await open(dc.verification_uri_complete); } catch { /* ignore */ }

      const result = await poll(
        async () => {
          const r = await fetch(`${brokerUrl}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: dc.device_code,
            }),
          });
          if (r.status === 400) {
            const body = await r.json() as { error: string };
            if (body.error === "authorization_pending") return null;
            console.error("\nDevice flow error:", body.error);
            process.exit(1);
          }
          if (!r.ok) return null;
          return r.json() as Promise<{
            access_token: string;
            expires_in: number;
            refresh_token?: string;
          }>;
        },
        dc.interval * 1000,
        dc.expires_in * 1000
      );

      if (!result) {
        console.error("Timed out waiting for authentication.");
        process.exit(1);
      }

      const now = new Date();
      const refreshTtlDays = 30;
      const session: BrokerSession = {
        broker_url: brokerUrl,
        access_token: result.access_token,
        access_token_expires_at: new Date(now.getTime() + result.expires_in * 1000).toISOString(),
        refresh_token: result.refresh_token,
        refresh_token_expires_at: result.refresh_token
          ? new Date(now.getTime() + refreshTtlDays * 86400 * 1000).toISOString()
          : undefined,
      };

      writeBrokerSession(cfgDir(), session);
      console.log(`\nLogged in to ${brokerUrl}`);
    });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  broker
    .command("logout")
    .description("Remove stored broker session")
    .action(() => {
      deleteBrokerSession(cfgDir());
      console.log("Logged out.");
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  broker
    .command("status")
    .description("Show broker health and uptime")
    .action(async () => {
      const session = await getValidSession(cfgDir);
      const data = await apiGet<{ status: string; uptime_seconds: number; version: string }>(
        session, "/api/status"
      );
      console.log(`Status:  ${data.status}`);
      console.log(`Uptime:  ${formatUptime(data.uptime_seconds)}`);
      console.log(`Version: ${data.version}`);
    });

  // -------------------------------------------------------------------------
  // agents
  // -------------------------------------------------------------------------

  const agents = broker.command("agents").description("Manage registered agents");

  agents
    .command("list")
    .description("List all registered agents")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const data = await apiGet<AgentEntry[]>(session, "/api/agents");
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
      for (const a of data) {
        console.log(`${a.host} (${a.id})`);
        console.log(`  Status: ${a.online ? "online" : "offline"}${a.last_heartbeat_at ? `  last seen ${a.last_heartbeat_at}` : ""}`);
        for (const l of a.labels) console.log(`  ${l.label} → ${l.reported_path}`);
      }
    });

  agents
    .command("revoke")
    .argument("<agent-id>", "Agent ID to revoke")
    .description("Immediately revoke an agent token")
    .action(async (agentId: string) => {
      const ok = await confirm(`Revoke token for agent ${agentId}? The agent will go offline.`);
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir);
      await apiDelete(session, `/api/agents/${agentId}/token`);
      console.log("Token revoked.");
    });

  // -------------------------------------------------------------------------
  // labels
  // -------------------------------------------------------------------------

  const labels = broker.command("labels").description("View path labels");

  labels
    .command("list")
    .description("List path labels")
    .option("--agent <id>", "Filter by agent ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { agent?: string; json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = opts.agent ? `?agent_id=${encodeURIComponent(opts.agent)}` : "";
      const data = await apiGet<LabelEntry[]>(session, `/api/labels${qs}`);
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
      for (const l of data) {
        console.log(`${l.label}  (${l.host})  →  ${l.reported_path}`);
      }
    });

  // -------------------------------------------------------------------------
  // filters
  // -------------------------------------------------------------------------

  const filters = broker.command("filters").description("Manage broker path deny filters");

  filters
    .command("list")
    .description("List active deny filters")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const data = await apiGet<FilterEntry[]>(session, "/api/filters");
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
      for (const f of data) {
        const scope = f.scope_agent_id ? ` [agent: ${f.scope_agent_id}]` : "";
        console.log(`${f.id}  ${f.pattern_type}:${f.pattern}${scope}  (${f.created_at})`);
      }
    });

  filters
    .command("add")
    .argument("<pattern>", "Glob or regex pattern to deny")
    .description("Add a deny filter")
    .option("--type <type>", "Pattern type: glob or regex", "glob")
    .option("--agent <id>", "Scope filter to a specific agent")
    .action(async (pattern: string, opts: { type: string; agent?: string }) => {
      if (opts.type !== "glob" && opts.type !== "regex") {
        console.error("--type must be glob or regex");
        process.exit(1);
      }
      const session = await getValidSession(cfgDir);
      const body: Record<string, string> = { pattern, pattern_type: opts.type };
      if (opts.agent) body["agent_id"] = opts.agent;
      const data = await apiPost<{ id: string }>(session, "/api/filters", body);
      console.log(`Filter created: ${data.id}`);
    });

  filters
    .command("remove")
    .argument("<filter-id>", "Filter ID to remove")
    .description("Remove a deny filter")
    .action(async (filterId: string) => {
      const session = await getValidSession(cfgDir);
      await apiDelete(session, `/api/filters/${filterId}`);
      console.log("Filter removed.");
    });

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  const sessions = broker.command("sessions").description("Manage MCP client sessions");

  sessions
    .command("list")
    .description("List active MCP client sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const data = await apiGet<SessionEntry[]>(session, "/api/sessions");
      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
      for (const s of data) {
        console.log(`${s.id}  client:${s.mcp_client_id}  issued:${s.issued_at}  expires:${s.expires_at}${s.has_refresh_token ? "  [refresh]" : ""}`);
      }
    });

  sessions
    .command("revoke")
    .argument("<session-id>", "Session ID to revoke")
    .description("Invalidate an MCP client session")
    .action(async (sessionId: string) => {
      const session = await getValidSession(cfgDir);
      await apiDelete(session, `/api/sessions/${sessionId}`);
      console.log("Session revoked.");
    });

  // -------------------------------------------------------------------------
  // users (AUTH_MODE=local only)
  // -------------------------------------------------------------------------

  const users = broker.command("users").description("Manage local broker users (requires AUTH_MODE=local on broker)");

  users
    .command("list")
    .description("List all local users")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const res = await apiGet<{ data: Array<{
        id: string; username: string; is_active: boolean;
        created_at: string; last_login_at: string | null;
      }> }>(session, "/api/users");
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
      for (const u of res.data) {
        const status = u.is_active ? "active" : "deactivated";
        const last = u.last_login_at ? `  last login: ${u.last_login_at}` : "";
        console.log(`${u.username}  [${status}]${last}`);
      }
    });

  users
    .command("add")
    .argument("<username>", "Username for the new user")
    .description("Create a new local user (prompts for password)")
    .action(async (username: string) => {
      const password = await promptPassword("Password (min 12 chars): ");
      const confirm = await promptPassword("Confirm password: ");
      if (password !== confirm) { console.error("Passwords do not match."); process.exit(1); }
      if (password.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }
      const session = await getValidSession(cfgDir);
      await apiPost(session, "/api/users", { username, password });
      console.log(`User '${username}' created.`);
    });

  users
    .command("remove")
    .argument("<username>", "Username to deactivate")
    .description("Deactivate a local user (soft delete)")
    .action(async (username: string) => {
      const ok = await confirm(`Deactivate user '${username}'? Their sessions will become invalid.`);
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir);
      await apiDelete(session, `/api/users/${encodeURIComponent(username)}`);
      console.log(`User '${username}' deactivated.`);
    });

  users
    .command("reset-password")
    .argument("<username>", "Username to update")
    .description("Reset a local user's password and invalidate their sessions")
    .action(async (username: string) => {
      const password = await promptPassword("New password (min 12 chars): ");
      const confirm = await promptPassword("Confirm new password: ");
      if (password !== confirm) { console.error("Passwords do not match."); process.exit(1); }
      if (password.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }
      const session = await getValidSession(cfgDir);
      await apiPost(session, `/api/users/${encodeURIComponent(username)}/reset-password`, { password });
      console.log(`Password reset for '${username}'. All existing sessions have been invalidated.`);
    });

  // -------------------------------------------------------------------------
  // account
  // -------------------------------------------------------------------------

  const account = broker.command("account").description("Manage your broker account");

  account
    .command("deactivate")
    .description("Deactivate your account — blocks all access immediately")
    .action(async () => {
      console.log("WARNING: This will immediately block all agent connections and MCP client access.");
      console.log("Your configuration is preserved but all tokens become invalid.\n");
      const ok = await confirm("Are you sure you want to deactivate your account?");
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir);
      await apiPost(session, "/api/account/deactivate", { confirm: "deactivate my account" });
      deleteBrokerSession(cfgDir());
      console.log("Account deactivated.");
    });

  // -------------------------------------------------------------------------
  // token — break-glass token management
  // -------------------------------------------------------------------------

  const tokenCmd = broker.command("token").description("Manage agent tokens (break-glass operations)");

  tokenCmd
    .command("create")
    .description("Create a new agent token")
    .requiredOption("--shared", "Create a SHARED service token (break-glass — prefer: constellation shared-agent register)")
    .action(async () => {
      console.error("╔══════════════════════════════════════════════════════════════════════════╗");
      console.error("║  BREAK-GLASS OPERATION                                                   ║");
      console.error("║                                                                          ║");
      console.error("║  The preferred registration path is:                                     ║");
      console.error("║    constellation shared-agent register --broker-url <url>               ║");
      console.error("║  That flow requires no manual token handling and is safer.               ║");
      console.error("║                                                                          ║");
      console.error("║  Use this command only when the device code flow is unavailable          ║");
      console.error("║  (e.g. scripted provisioning or break-glass recovery).                  ║");
      console.error("║                                                                          ║");
      console.error("║  The token is shown ONCE. Store it immediately in a secure location.    ║");
      console.error("║  Treat it as a root-level credential — it is not user-scoped.           ║");
      console.error("╚══════════════════════════════════════════════════════════════════════════╝");
      console.error("");

      const ok = await confirm("Proceed with break-glass shared token creation?");
      if (!ok) { console.log("Cancelled."); return; }

      const session = await getValidSession(cfgDir);
      const data = await apiPost<{ token: string; token_id: string; created_at: string }>(
        session, "/api/tokens/shared", {}
      );

      console.log("");
      console.log("=== SHARED AGENT TOKEN (shown once) ===");
      console.log("");
      console.log(data.token);
      console.log("");
      console.log(`Token ID:   ${data.token_id}`);
      console.log(`Created at: ${data.created_at}`);
      console.log("");
      console.log("Store this token as CONSTELLATION_AGENT_TOKEN in the agent's environment.");
      console.log("It will not be shown again. Revoke via: constellation broker agents revoke <agent-id>");
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    let input = "";
    const onData = (char: string) => {
      if (char === "\r" || char === "\n") {
        process.stdout.write("\n");
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        resolve(input);
      } else if (char === "") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "") {
        if (input.length > 0) input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    process.stdin.on("data", onData);
  });
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
