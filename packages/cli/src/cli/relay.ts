import { Command } from "commander";
import {
  configDir,
  loadNodeConfig,
  loadRelaySession,
  deleteRelaySession,
  type RelaySession,
} from "@constellation/node/config";
import { confirm, type ExecutorEntry, assertSecureHttpUrl, isSameOrigin, sanitizeForTerminal as t, sanitizeJsonStrings } from "@constellation/shared";
import { adminStepUp, getValidSession, login, revokeStoredSession } from "./session.js";

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

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

interface HubShareEntry {
  executor_id: string;
  executor_host: string;
  share: string;
  reported_path: string;
  permission_blob: {
    default: string;
    overrides?: Array<{ sub: string; access: string } | { group: string; access: string }>;
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
  const url = flagUrl ?? (() => {
    try {
      return loadNodeConfig(getConfigDir()).relay_url;
    } catch {
      console.error("No relay URL configured. Pass --relay <url> or run constellation node init first.");
      process.exit(1);
    }
  })();
  try {
    assertSecureHttpUrl(url);
  } catch (err) {
    console.error("Error:", t((err as Error).message));
    process.exit(1);
  }
  return url;
}

/** Wraps `fetch` so a network failure (DNS, connection refused, timeout) surfaces with
 * the host it was trying to reach, instead of a bare contextless TypeError. */
async function safeFetch(url: string, options?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (err) {
    console.error(`Could not reach ${t(new URL(url).host)}: ${t((err as Error).message)}`);
    return process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Session management: see session.ts for refresh, locking and the admin step-up
// ---------------------------------------------------------------------------

/** A session carrying a one-command admin token, for the few commands the relay gates on the
 * `admin` scope. Nothing is written to disk; the token is gone when the command ends. */
async function getAdminSession(
  getConfigDir: () => string,
  relayUrlFlag: string | undefined
): Promise<RelaySession> {
  // Prefer the relay the user is signed in to over the node config's.
  const stored = (() => {
    try { return loadRelaySession(getConfigDir()); } catch { return undefined; }
  })();
  const relayUrl = resolveRelayUrl(relayUrlFlag ?? stored?.relay_url, getConfigDir);
  // Pinned to the authorization server of the stored sign-in (for the same relay): a relay that now
  // names another is refused, not asked for an admin token.
  const issuer = stored?.issuer && isSameOrigin(stored.relay_url, relayUrl) ? stored.issuer : undefined;
  const accessToken = await adminStepUp(relayUrl, issuer);
  return { relay_url: relayUrl, access_token: accessToken, access_token_expires_at: new Date(Date.now() + 300_000).toISOString() };
}

// ---------------------------------------------------------------------------
// Authenticated fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(
  session: RelaySession,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  return safeFetch(`${session.relay_url}${path}`, {
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
  return parseJson<T>(res);
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
  // The counts come from the server and are printed in a command line the user may copy: anything
  // but a plain non-negative integer drops the footer rather than printing it.
  const counts = [res.offset, res.total, res.data.length];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) return;
  const shown = res.offset + res.data.length;
  if (!Number.isSafeInteger(shown)) return;
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
  return parseJson<T>(res);
}

/** Parses a response body expected to be JSON on success; a non-JSON body here means
 * something between us and the relay (a proxy error page, a truncated response) broke,
 * not an application-level error — surface that distinction instead of a raw SyntaxError. */
async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    console.error(`Unexpected response from relay (status ${res.status}): expected JSON, got something else.`);
    return process.exit(1);
  }
}

export async function die(res: Response): Promise<never> {
  try {
    const body: unknown = await res.json();
    const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : undefined;
    if (error === "insufficient_scope") {
      console.error("This operation requires admin privileges, and your account or this command's token lacks them.");
    } else if (res.status === 401) {
      console.error(`API error 401: ${t(JSON.stringify(body))}`);
      console.error("The relay did not accept the stored sign-in. Run 'constellation relay login' to sign in again.");
    } else {
      console.error(`API error ${res.status}: ${t(JSON.stringify(body))}`);
    }
  } catch {
    console.error(`API error ${res.status}`);
  }
  return process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    .description("Sign in to the relay's authorization server (OAuth device flow)")
    .option("--accept-new-issuer", "Without a terminal, accept that the relay now names a different authorization server than your current sign-in")
    .action(async (opts: { acceptNewIssuer?: boolean }) => {
      const relayUrl = resolveRelayUrl(getRelayFlag(), getConfigDir);
      await login(relayUrl, cfgDir(), opts.acceptNewIssuer);
      console.log(`\nLogged in to ${relayUrl}`);
    });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------

  relay
    .command("logout")
    .description("Revoke the stored sign-in at the authorization server, then remove the relay session")
    .action(async () => {
      await revokeStoredSession(cfgDir());
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
      const session = await getValidSession(cfgDir());
      const data = await apiGet<{ status: string; uptime_seconds: number; version: string }>(
        session, "/api/status"
      );
      console.log(`Status:  ${t(data.status)}`);
      console.log(`Uptime:  ${formatUptime(data.uptime_seconds)}`);
      console.log(`Version: ${t(data.version)}`);
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
      const session = await getValidSession(cfgDir());
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<ExecutorEntry>>(session, `/api/executors${qs}`);
      if (opts.json) { console.log(JSON.stringify(sanitizeJsonStrings(res.data), null, 2)); warnIfMore(res); return; }
      for (const a of res.data) {
        console.log(`${t(a.host)} (${t(a.id)})`);
        console.log(`  Status: ${a.online ? "online" : "offline"}${a.last_heartbeat_at ? `  last seen ${t(a.last_heartbeat_at)}` : ""}`);
        for (const s of a.shares) console.log(`  ${t(s.share)} → ${t(s.reported_path)}`);
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
      const session = await getValidSession(cfgDir());
      await apiDelete(session, `/api/executors/${encodeURIComponent(executorId)}/token`);
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
      const session = await getValidSession(cfgDir());
      const qs = buildListQuery(opts, { executor_id: opts.executor });
      const res = await apiGet<PaginatedResponse<ShareEntry>>(session, `/api/shares${qs}`);
      if (opts.json) { console.log(JSON.stringify(sanitizeJsonStrings(res.data), null, 2)); warnIfMore(res); return; }
      for (const s of res.data) {
        console.log(`${t(s.share)}  (${t(s.host)})  →  ${t(s.reported_path)}`);
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
      const session = await getValidSession(cfgDir());
      const qs = buildListQuery(opts);
      const res = await apiGet<PaginatedResponse<FilterEntry>>(session, `/api/filters${qs}`);
      if (opts.json) { console.log(JSON.stringify(sanitizeJsonStrings(res.data), null, 2)); warnIfMore(res); return; }
      for (const f of res.data) {
        const scope = f.scope_executor_id ? ` [executor: ${t(f.scope_executor_id)}]` : "";
        console.log(`${t(f.id)}  ${t(f.pattern_type)}:${t(f.pattern)}${scope}  (${t(f.created_at)})`);
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
      const session = await getValidSession(cfgDir());
      const body: Record<string, string> = { pattern, pattern_type: opts.type };
      if (opts.executor) body["executor_id"] = opts.executor;
      const data = await apiPost<{ id: string }>(session, "/api/filters", body);
      console.log(`Filter created: ${t(data.id)}`);
    });

  filters
    .command("remove")
    .argument("<filter-id>", "Filter ID to remove")
    .description("Remove a deny filter")
    .action(async (filterId: string) => {
      const ok = await confirm(`Remove deny filter ${filterId}? This widens access — anything it was blocking becomes reachable again.`);
      if (!ok) { console.log("Cancelled."); return; }
      const session = await getValidSession(cfgDir());
      await apiDelete(session, `/api/filters/${encodeURIComponent(filterId)}`);
      console.log("Filter removed.");
    });

  // -------------------------------------------------------------------------
  // hub-shares — admin view of the hub share registry
  // -------------------------------------------------------------------------

  const hubShares = relay.command("hub-shares").description("View hub shares (needs admin: asks you to approve an admin sign-in)");

  hubShares
    .command("list")
    .description("List all hub shares synced to the relay")
    .option("--executor <id>", "Filter to a specific hub by ID")
    .option("--limit <n>", "Max rows to return (server caps at 1000)", "100")
    .option("--offset <n>", "Rows to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (opts: ListOpts & { executor?: string; json?: boolean }) => {
      const session = await getAdminSession(cfgDir, getRelayFlag());
      const qs = buildListQuery(opts, { executor_id: opts.executor });
      const data = await apiGet<PaginatedResponse<HubShareEntry>>(session, `/api/admin/hub-shares${qs}`);
      if (opts.json) { console.log(JSON.stringify(sanitizeJsonStrings(data.data), null, 2)); warnIfMore(data); return; }

      if (data.data.length === 0) {
        console.log(data.total > 0 ? `No hub shares at this offset (${data.total} total — try --offset 0).` : "No hub shares found.");
        return;
      }

      let lastExecutorId = "";
      for (const s of data.data) {
        if (s.executor_id !== lastExecutorId) {
          console.log(`\nExecutor: ${t(s.executor_host)} (${t(s.executor_id)})`);
          lastExecutorId = s.executor_id;
        }
        const overrides = s.permission_blob.overrides ?? [];
        const overrideStr = overrides.length > 0
          ? `  overrides: ${overrides.map((o) => `${"sub" in o ? o.sub : `group:${o.group}`}=${o.access}`).join(", ")}`
          : "";
        console.log(`  ${t(s.share)}  →  ${t(s.reported_path)}  [default: ${t(s.permission_blob.default)}]${t(overrideStr)}`);
      }
      warnIfMore(data);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
