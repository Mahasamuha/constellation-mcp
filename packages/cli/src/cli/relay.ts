import { Command } from "commander";
import open from "open";
import {
  configDir,
  loadNodeConfig,
  loadRelaySession,
  writeRelaySession,
  deleteRelaySession,
  type RelaySession,
} from "@constellation/node/config";
import { poll, confirm } from "@constellation/shared";

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

interface ExecutorEntry {
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
  scope_executor_id: string | null;
  created_at: string;
}

interface SessionEntry {
  id: string;
  mcp_client_id: string;
  issued_at: string;
  expires_at: string;
  has_refresh_token: boolean;
}

interface SharedLabelEntry {
  executor_id: string;
  executor_host: string;
  label: string;
  reported_path: string;
  permission_blob: {
    default: string;
    overrides?: Array<{ oidc_sub: string; access: string }>;
  };
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Relay URL resolution
// ---------------------------------------------------------------------------

function resolveRelayUrl(flagUrl: string | undefined, getConfigDir: () => string): string {
  if (flagUrl) return flagUrl;
  try {
    return loadNodeConfig(getConfigDir()).relay_url;
  } catch {
    console.error(
      "No relay URL configured. Pass --relay <url> or run constellation node init first."
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Session management with silent refresh
// ---------------------------------------------------------------------------

async function getValidSession(getConfigDir: () => string): Promise<RelaySession> {
  const dir = getConfigDir();
  let session: RelaySession;

  try {
    session = loadRelaySession(dir);
  } catch {
    console.error("Not logged in. Run 'constellation relay login' first.");
    process.exit(1);
  }

  const expiresAt = new Date(session.access_token_expires_at);
  if (expiresAt > new Date()) return session;

  // Try silent refresh.
  if (session.refresh_token) {
    const refreshed = await tryRefresh(session);
    if (refreshed) {
      writeRelaySession(dir, refreshed);
      return refreshed;
    }
  }

  console.error("Session expired. Run 'constellation relay login' to re-authenticate.");
  process.exit(1);
}

async function tryRefresh(session: RelaySession): Promise<RelaySession | null> {
  if (!session.refresh_token) return null;

  const res = await fetch(`${session.relay_url}/oauth/token`, {
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
    relay_url: session.relay_url,
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
  session: RelaySession,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${session.relay_url}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
}

async function apiGet<T>(session: RelaySession, path: string): Promise<T> {
  const res = await apiFetch(session, path);
  if (!res.ok) die(res);
  return res.json() as Promise<T>;
}

async function apiDelete(session: RelaySession, path: string): Promise<void> {
  const res = await apiFetch(session, path, { method: "DELETE" });
  if (!res.ok) die(res);
}

async function apiPost<T>(
  session: RelaySession,
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
  res.json().then((body: unknown) => {
    if (
      typeof body === "object" && body !== null &&
      (body as Record<string, unknown>)["error"] === "ESCALATION_REQUIRED"
    ) {
      console.error("This operation requires admin privileges.");
      console.error("Run 'constellation relay elevate' to request temporary admin access, then retry.");
    } else {
      console.error(`API error ${res.status}: ${JSON.stringify(body)}`);
    }
  }).catch(() => { console.error(`API error ${res.status}`); });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Register all relay commands
// ---------------------------------------------------------------------------

export function registerRelayCommands(program: Command): void {
  const relay = program
    .command("relay")
    .description("Manage the remote Constellation relay")
    .option("--relay <url>", "Override relay URL")
    .option("--config-dir <dir>", "Override config directory", process.env["CONSTELLATION_CONFIG_DIR"]);

  const getConfigDir = (): string => configDir(relay.opts<{ configDir?: string }>().configDir);
  // Capture as a local const so Commander action callbacks don't confuse it with an arg.
  const cfgDir = getConfigDir;

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  relay
    .command("login")
    .description("Authenticate with the relay (OAuth device flow)")
    .option("--relay <url>", "Relay URL")
    .action(async (opts: { relay?: string }, cmd: Command) => {
      const relayUrl = resolveRelayUrl(
        opts.relay ?? (cmd.parent?.opts() as { relay?: string }).relay,
        getConfigDir
      );

      const dcRes = await fetch(`${relayUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ scope: "relay:manage" }),
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
          const r = await fetch(`${relayUrl}/oauth/token`, {
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
      const session: RelaySession = {
        relay_url: relayUrl,
        access_token: result.access_token,
        access_token_expires_at: new Date(now.getTime() + result.expires_in * 1000).toISOString(),
        refresh_token: result.refresh_token,
        refresh_token_expires_at: result.refresh_token
          ? new Date(now.getTime() + refreshTtlDays * 86400 * 1000).toISOString()
          : undefined,
      };

      writeRelaySession(cfgDir(), session);
      console.log(`\nLogged in to ${relayUrl}`);
    });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  relay
    .command("logout")
    .description("Remove stored relay session")
    .action(() => {
      deleteRelaySession(cfgDir());
      console.log("Logged out.");
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  relay
    .command("status")
    .description("Show relay health and uptime")
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
  // executors
  // -------------------------------------------------------------------------

  const executors = relay.command("executors").description("Manage registered executors");

  executors
    .command("list")
    .description("List all registered executors")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const res = await apiGet<{ data: ExecutorEntry[] }>(session, "/api/executors");
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
      for (const a of res.data) {
        console.log(`${a.host} (${a.id})`);
        console.log(`  Status: ${a.online ? "online" : "offline"}${a.last_heartbeat_at ? `  last seen ${a.last_heartbeat_at}` : ""}`);
        for (const l of a.labels) console.log(`  ${l.label} → ${l.reported_path}`);
      }
    });

  executors
    .command("revoke")
    .argument("<executor-id>", "Executor ID to revoke")
    .description("Immediately revoke an executor token")
    .action(async (executorId: string) => {
      const ok = await confirm(`Revoke token for executor ${executorId}? The executor will go offline.`);
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir);
      await apiDelete(session, `/api/executors/${executorId}/token`);
      console.log("Token revoked.");
    });

  // -------------------------------------------------------------------------
  // labels
  // -------------------------------------------------------------------------

  const labels = relay.command("labels").description("View path labels");

  labels
    .command("list")
    .description("List path labels")
    .option("--executor <id>", "Filter by executor ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { executor?: string; json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = opts.executor ? `?executor_id=${encodeURIComponent(opts.executor)}` : "";
      const res = await apiGet<{ data: LabelEntry[] }>(session, `/api/labels${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
      for (const l of res.data) {
        console.log(`${l.label}  (${l.host})  →  ${l.reported_path}`);
      }
    });

  // -------------------------------------------------------------------------
  // filters
  // -------------------------------------------------------------------------

  const filters = relay.command("filters").description("Manage relay path deny filters");

  filters
    .command("list")
    .description("List active deny filters")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const res = await apiGet<{ data: FilterEntry[] }>(session, "/api/filters");
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
      for (const f of res.data) {
        const scope = f.scope_executor_id ? ` [executor: ${f.scope_executor_id}]` : "";
        console.log(`${f.id}  ${f.pattern_type}:${f.pattern}${scope}  (${f.created_at})`);
      }
    });

  filters
    .command("add")
    .argument("<pattern>", "Glob or regex pattern to deny")
    .description("Add a deny filter")
    .option("--type <type>", "Pattern type: glob or regex", "glob")
    .option("--executor <id>", "Scope filter to a specific executor")
    .action(async (pattern: string, opts: { type: string; executor?: string }) => {
      if (opts.type !== "glob" && opts.type !== "regex") {
        console.error("--type must be glob or regex");
        process.exit(1);
      }
      const session = await getValidSession(cfgDir);
      const body: Record<string, string> = { pattern, pattern_type: opts.type };
      if (opts.executor) body["executor_id"] = opts.executor;
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

  const sessions = relay.command("sessions").description("Manage MCP client sessions");

  sessions
    .command("list")
    .description("List active MCP client sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const res = await apiGet<{ data: SessionEntry[] }>(session, "/api/sessions");
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
      for (const s of res.data) {
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

  const users = relay.command("users").description("Manage local relay users (requires AUTH_MODE=local on relay)");

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

  const account = relay.command("account").description("Manage your relay account");

  account
    .command("deactivate")
    .description("Deactivate your account — blocks all access immediately")
    .action(async () => {
      console.log("WARNING: This will immediately block all executor connections and MCP client access.");
      console.log("Your configuration is preserved but all tokens become invalid.\n");
      const ok = await confirm("Are you sure you want to deactivate your account?");
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir);
      await apiPost(session, "/api/account/deactivate", { confirm: "deactivate my account" });
      deleteRelaySession(cfgDir());
      console.log("Account deactivated.");
    });

  // -------------------------------------------------------------------------
  // elevate — request temporary admin session elevation
  // -------------------------------------------------------------------------

  relay
    .command("elevate")
    .description("Request temporary admin access via browser approval (step-up authentication)")
    .option("--relay <url>", "Override relay URL")
    .action(async (opts: { relay?: string }, cmd: Command) => {
      const session = await getValidSession(cfgDir);
      const relayUrl = resolveRelayUrl(
        opts.relay ?? (cmd.parent?.opts() as { relay?: string }).relay,
        getConfigDir
      );

      // Fetch the current session ID from the relay (not stored locally).
      const meRes = await apiFetch(session, "/api/me");
      if (!meRes.ok) { console.error("Failed to fetch session info."); process.exit(1); }
      const me = await meRes.json() as { session_id: string };

      const dcRes = await fetch(`${relayUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          scope: "agent:escalate",
          elevate_session_id: me.session_id,
        }),
      });

      if (!dcRes.ok) {
        console.error("Failed to start escalation flow:", await dcRes.text());
        process.exit(1);
      }
      const dc = await dcRes.json() as {
        device_code: string;
        user_code: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };

      console.log(`\nOpen the following URL to approve admin access (opening browser automatically):`);
      console.log(`  ${dc.verification_uri_complete}\n`);
      console.log(`If the browser did not open, enter this code: ${dc.user_code}\n`);
      try { await open(dc.verification_uri_complete); } catch { /* ignore */ }

      const result = await poll(
        async () => {
          const r = await fetch(`${relayUrl}/oauth/token`, {
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
            if (body.error === "access_denied") {
              console.error("\nEscalation denied. Ensure your account has admin privileges.");
              process.exit(1);
            }
            console.error("\nEscalation flow error:", body.error);
            process.exit(1);
          }
          if (r.status === 204) return {};
          if (!r.ok) return null;
          return {};
        },
        dc.interval * 1000,
        dc.expires_in * 1000
      );

      if (!result) {
        console.error("Timed out waiting for approval.");
        process.exit(1);
      }

      console.log("Admin access granted. Retry your command.");
    });

  // -------------------------------------------------------------------------
  // user promote/demote — bootstrap role management (requires RELAY_ADMIN_TOKEN)
  // -------------------------------------------------------------------------

  const userAdmin = relay.command("user").description("Manage user roles (requires RELAY_ADMIN_TOKEN)");

  userAdmin
    .command("promote")
    .argument("<identifier>", "OIDC sub or (local mode) username to promote to admin")
    .description("Grant admin role — requires RELAY_ADMIN_TOKEN env var or --admin-token flag")
    .option("--relay <url>", "Override relay URL")
    .option("--admin-token <token>", "Relay admin token (defaults to RELAY_ADMIN_TOKEN env var)")
    .action(async (identifier: string, opts: { relay?: string; adminToken?: string }, cmd: Command) => {
      const adminToken = opts.adminToken ?? process.env["RELAY_ADMIN_TOKEN"];
      if (!adminToken) {
        console.error("RELAY_ADMIN_TOKEN is not set. Pass --admin-token or set the env var.");
        process.exit(1);
      }
      const relayUrl = resolveRelayUrl(
        opts.relay ?? (cmd.parent?.opts() as { relay?: string }).relay,
        getConfigDir
      );
      const res = await fetch(`${relayUrl}/api/admin/users/${encodeURIComponent(identifier)}/promote`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 404) { console.error("User not found."); process.exit(1); }
      if (!res.ok) { console.error(`Error ${res.status}:`, await res.text()); process.exit(1); }
      console.log(`User '${identifier}' promoted to admin.`);
    });

  userAdmin
    .command("demote")
    .argument("<identifier>", "OIDC sub or (local mode) username to demote")
    .description("Revoke admin role — requires RELAY_ADMIN_TOKEN env var or --admin-token flag")
    .option("--relay <url>", "Override relay URL")
    .option("--admin-token <token>", "Relay admin token (defaults to RELAY_ADMIN_TOKEN env var)")
    .action(async (identifier: string, opts: { relay?: string; adminToken?: string }, cmd: Command) => {
      const adminToken = opts.adminToken ?? process.env["RELAY_ADMIN_TOKEN"];
      if (!adminToken) {
        console.error("RELAY_ADMIN_TOKEN is not set. Pass --admin-token or set the env var.");
        process.exit(1);
      }
      const relayUrl = resolveRelayUrl(
        opts.relay ?? (cmd.parent?.opts() as { relay?: string }).relay,
        getConfigDir
      );
      const res = await fetch(`${relayUrl}/api/admin/users/${encodeURIComponent(identifier)}/demote`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 404) { console.error("User not found."); process.exit(1); }
      if (!res.ok) { console.error(`Error ${res.status}:`, await res.text()); process.exit(1); }
      console.log(`User '${identifier}' demoted to regular user.`);
    });

  // -------------------------------------------------------------------------
  // shared-labels — admin view of the shared label registry
  // -------------------------------------------------------------------------

  const sharedLabels = relay.command("shared-labels").description("View hub labels (requires admin session)");

  sharedLabels
    .command("list")
    .description("List all shared labels synced to the relay")
    .option("--executor <id>", "Filter to a specific hub by ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { executor?: string; json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = opts.executor ? `?executor=${encodeURIComponent(opts.executor)}` : "";
      const data = await apiGet<{ data: SharedLabelEntry[] }>(session, `/api/admin/shared-labels${qs}`);
      if (opts.json) { console.log(JSON.stringify(data.data, null, 2)); return; }

      if (data.data.length === 0) {
        console.log("No shared labels found.");
        return;
      }

      let lastExecutorId = "";
      for (const l of data.data) {
        if (l.executor_id !== lastExecutorId) {
          console.log(`\nExecutor: ${l.executor_host} (${l.executor_id})`);
          lastExecutorId = l.executor_id;
        }
        const overrides = l.permission_blob.overrides ?? [];
        const overrideStr = overrides.length > 0
          ? `  overrides: ${overrides.map((o) => `${o.oidc_sub}=${o.access}`).join(", ")}`
          : "";
        console.log(`  ${l.label}  →  ${l.reported_path}  [default: ${l.permission_blob.default}]${overrideStr}`);
      }
    });

  // -------------------------------------------------------------------------
  // token — break-glass token management
  // -------------------------------------------------------------------------

  const tokenCmd = relay.command("token").description("Manage executor tokens (break-glass operations)");

  tokenCmd
    .command("create")
    .description("Create a new executor token")
    .requiredOption("--shared", "Create a HUB service token (break-glass — prefer: constellation hub register)")
    .action(async () => {
      console.error("╔══════════════════════════════════════════════════════════════════════════╗");
      console.error("║  BREAK-GLASS OPERATION                                                   ║");
      console.error("║                                                                          ║");
      console.error("║  The preferred registration path is:                                     ║");
      console.error("║    constellation hub register --relay-url <url>                         ║");
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
      console.log("=== HUB TOKEN (shown once) ===");
      console.log("");
      console.log(data.token);
      console.log("");
      console.log(`Token ID:   ${data.token_id}`);
      console.log(`Created at: ${data.created_at}`);
      console.log("");
      console.log("Store this token as CONSTELLATION_HUB_TOKEN in the hub's environment.");
      console.log("It will not be shown again. Revoke via: constellation relay executors revoke <executor-id>");
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
