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
  shares: Array<{ share: string; reported_path: string }>;
}

interface ShareEntry {
  share: string;
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

interface LocalUserEntry {
  id: string;
  username: string;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface HubShareEntry {
  executor_id: string;
  executor_host: string;
  share: string;
  reported_path: string;
  permission_blob: {
    default: string;
    overrides?: Array<{ oidc_sub: string; access: string }>;
  };
  updated_at: string;
}

/** Every `GET /api/*` list endpoint paginates (default 100, max 1000 rows per page)
 * and returns this shape — see docs/reference.md's pagination section. */
interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

interface ListOpts {
  limit: string;
  offset: string;
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
  if (!res.ok) await die(res);
  return res.json() as Promise<T>;
}

/** Builds a `list` command's query string from its --limit/--offset options plus
 * any command-specific filters, omitting anything not actually set. */
function buildListQuery(opts: ListOpts, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  if (opts.limit) params.set("limit", opts.limit);
  if (opts.offset) params.set("offset", opts.offset);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Warns when the server paginated and more rows exist beyond what's shown — to
 * stderr, so --json output stays valid, pipeable JSON either way. */
function warnIfMore(res: PaginatedResponse<unknown>): void {
  const shown = res.offset + res.data.length;
  if (shown < res.total) {
    console.error(`Showing ${res.data.length} of ${res.total} total (offset ${res.offset}) — use --offset ${shown} to see more.`);
  }
}

async function apiDelete(session: RelaySession, path: string): Promise<void> {
  const res = await apiFetch(session, path, { method: "DELETE" });
  if (!res.ok) await die(res);
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
  if (!res.ok) await die(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function die(res: Response): Promise<never> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" && body !== null &&
      (body as Record<string, unknown>)["error"] === "ESCALATION_REQUIRED"
    ) {
      console.error("This operation requires admin privileges.");
      console.error("Run 'constellation relay elevate' to request temporary admin access, then retry.");
    } else {
      console.error(`API error ${res.status}: ${JSON.stringify(body)}`);
    }
  } catch {
    console.error(`API error ${res.status}`);
  }
  return process.exit(1);
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
  // --relay is declared once, here, on the top-level `relay` command. Resolve it via this
  // closure everywhere — Commander does not reliably forward an ancestor's option value to a
  // command nested two or more levels deep (e.g. relay -> user -> promote), and redeclaring
  // --relay locally on each subcommand doesn't help once any ancestor option is also present.
  const getRelayFlag = (): string | undefined => relay.opts<{ relay?: string }>().relay;

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  relay
    .command("login")
    .description("Authenticate with the relay (OAuth device flow)")
    .action(async () => {
      const relayUrl = resolveRelayUrl(getRelayFlag(), getConfigDir);

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
        async ({ intervalMs, setIntervalMs }) => {
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
            if (body.error === "slow_down") { setIntervalMs(intervalMs + 5000); return null; }
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
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<ExecutorEntry>>(session, `/api/executors${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); warnIfMore(res); return; }
      for (const a of res.data) {
        console.log(`${a.host} (${a.id})`);
        console.log(`  Status: ${a.online ? "online" : "offline"}${a.last_heartbeat_at ? `  last seen ${a.last_heartbeat_at}` : ""}`);
        for (const s of a.shares) console.log(`  ${s.share} → ${s.reported_path}`);
      }
      warnIfMore(res);
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
  // shares
  // -------------------------------------------------------------------------

  const shares = relay.command("shares").description("View path shares");

  shares
    .command("list")
    .description("List path shares")
    .option("--executor <id>", "Filter by executor ID")
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { executor?: string; json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts, { executor_id: opts.executor });
      const res = await apiGet<PaginatedResponse<ShareEntry>>(session, `/api/shares${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); warnIfMore(res); return; }
      for (const s of res.data) {
        console.log(`${s.share}  (${s.host})  →  ${s.reported_path}`);
      }
      warnIfMore(res);
    });

  // -------------------------------------------------------------------------
  // filters
  // -------------------------------------------------------------------------

  const filters = relay.command("filters").description("Manage relay path deny filters");

  filters
    .command("list")
    .description("List active deny filters")
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<FilterEntry>>(session, `/api/filters${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); warnIfMore(res); return; }
      for (const f of res.data) {
        const scope = f.scope_executor_id ? ` [executor: ${f.scope_executor_id}]` : "";
        console.log(`${f.id}  ${f.pattern_type}:${f.pattern}${scope}  (${f.created_at})`);
      }
      warnIfMore(res);
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
      const ok = await confirm(`Remove deny filter ${filterId}? This widens access — anything it was blocking becomes reachable again.`);
      if (!ok) { console.log("Cancelled."); return; }
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
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<SessionEntry>>(session, `/api/sessions${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); warnIfMore(res); return; }
      for (const s of res.data) {
        console.log(`${s.id}  client:${s.mcp_client_id}  issued:${s.issued_at}  expires:${s.expires_at}${s.has_refresh_token ? "  [refresh]" : ""}`);
      }
      warnIfMore(res);
    });

  sessions
    .command("revoke")
    .argument("<session-id>", "Session ID to revoke")
    .description("Invalidate an MCP client session")
    .action(async (sessionId: string) => {
      const ok = await confirm(`Revoke session ${sessionId}? The MCP client will need to re-authenticate.`);
      if (!ok) { console.log("Cancelled."); return; }
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
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<LocalUserEntry>>(session, `/api/users${qs}`);
      if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); warnIfMore(res); return; }
      for (const u of res.data) {
        const status = u.is_active ? "active" : "deactivated";
        const last = u.last_login_at ? `  last login: ${u.last_login_at}` : "";
        console.log(`${u.username}  [${status}]${last}`);
      }
      warnIfMore(res);
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
      await apiPost(session, `/api/users/${encodeURIComponent(username)}/deactivate`, {});
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
    .action(async () => {
      const session = await getValidSession(cfgDir);
      const relayUrl = resolveRelayUrl(getRelayFlag(), getConfigDir);

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
        async ({ intervalMs, setIntervalMs }) => {
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
            if (body.error === "slow_down") { setIntervalMs(intervalMs + 5000); return null; }
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
    .option("--admin-token <token>", "Relay admin token (defaults to RELAY_ADMIN_TOKEN env var)")
    .action(async (identifier: string, opts: { adminToken?: string }) => {
      const adminToken = opts.adminToken ?? process.env["RELAY_ADMIN_TOKEN"];
      if (!adminToken) {
        console.error("RELAY_ADMIN_TOKEN is not set. Pass --admin-token or set the env var.");
        process.exit(1);
      }
      const relayUrl = resolveRelayUrl(getRelayFlag(), getConfigDir);
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
    .option("--admin-token <token>", "Relay admin token (defaults to RELAY_ADMIN_TOKEN env var)")
    .action(async (identifier: string, opts: { adminToken?: string }) => {
      const adminToken = opts.adminToken ?? process.env["RELAY_ADMIN_TOKEN"];
      if (!adminToken) {
        console.error("RELAY_ADMIN_TOKEN is not set. Pass --admin-token or set the env var.");
        process.exit(1);
      }
      const relayUrl = resolveRelayUrl(getRelayFlag(), getConfigDir);
      const res = await fetch(`${relayUrl}/api/admin/users/${encodeURIComponent(identifier)}/demote`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 404) { console.error("User not found."); process.exit(1); }
      if (!res.ok) { console.error(`Error ${res.status}:`, await res.text()); process.exit(1); }
      console.log(`User '${identifier}' demoted to regular user.`);
    });

  // -------------------------------------------------------------------------
  // hub-shares — admin view of the hub share registry
  // -------------------------------------------------------------------------

  const hubShares = relay.command("hub-shares").description("View hub shares (requires admin session)");

  hubShares
    .command("list")
    .description("List all hub shares synced to the relay")
    .option("--executor <id>", "Filter to a specific hub by ID")
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { executor?: string; json?: boolean }) => {
      const session = await getValidSession(cfgDir);
      const qs = buildListQuery(opts, { executor: opts.executor });
      const data = await apiGet<PaginatedResponse<HubShareEntry>>(session, `/api/admin/hub-shares${qs}`);
      if (opts.json) { console.log(JSON.stringify(data.data, null, 2)); warnIfMore(data); return; }

      if (data.data.length === 0) {
        console.log(data.total > 0 ? `No hub shares at this offset (${data.total} total — try --offset 0).` : "No hub shares found.");
        return;
      }

      let lastExecutorId = "";
      for (const s of data.data) {
        if (s.executor_id !== lastExecutorId) {
          console.log(`\nExecutor: ${s.executor_host} (${s.executor_id})`);
          lastExecutorId = s.executor_id;
        }
        const overrides = s.permission_blob.overrides ?? [];
        const overrideStr = overrides.length > 0
          ? `  overrides: ${overrides.map((o) => `${o.oidc_sub}=${o.access}`).join(", ")}`
          : "";
        console.log(`  ${s.share}  →  ${s.reported_path}  [default: ${s.permission_blob.default}]${overrideStr}`);
      }
      warnIfMore(data);
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
      console.error("║    constellation hub register --relay <url>                              ║");
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
