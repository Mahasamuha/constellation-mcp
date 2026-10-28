import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

declare const __PKG_VERSION__: string;
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { registerNodeCommands } from "@constellation/node/cli";
import { registerRelayCommands, die } from "./cli/relay.js";
import { registerHubCommands } from "@constellation/hub/cli";
import { writeRelaySession, relaySessionPath, loadRelaySession } from "@constellation/node/config";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

// Instant polling: the device flow sleeps `interval` seconds before every poll. The mock targets
// cli-util itself because asterism-client and file-lock import sleep from there.
vi.mock("../../shared/src/cli-util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/src/cli-util.js")>();
  return { ...actual, sleep: async () => {} };
});
vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));
vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  return { ...actual, confirm: vi.fn() };
});
import { confirm as mockedConfirm } from "@constellation/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

interface RunResult {
  exitCode: number;
  out: string;
  err: string;
}

async function runCli(args: string[], dir: string): Promise<RunResult> {
  const outLines: string[] = [];
  const errLines: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
    outLines.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
    errLines.push(a.map(String).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ExitError(typeof code === "number" ? code : 0);
  });

  const program = new Command();
  program.configureOutput({
    writeOut: (s) => outLines.push(s),
    writeErr: (s) => errLines.push(s),
  });
  program
    .name("constellation")
    .version(__PKG_VERSION__);

  registerNodeCommands(program);
  registerRelayCommands(program);
  registerHubCommands(program);

  // --config-dir is declared on the `node`/`relay` parent commands — inject it
  // right after the subtree name so every test points at the temp config dir.
  const argv = (args[0] === "node" || args[0] === "relay")
    ? [args[0], "--config-dir", dir, ...args.slice(1)]
    : args;

  let exitCode = 0;
  try {
    await program.parseAsync(["node", "cli", ...argv]);
  } catch (e) {
    if (e instanceof ExitError) {
      exitCode = e.code;
    } else {
      throw e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, out: outLines.join("\n"), err: errLines.join("\n") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(dir);
});

// ---------------------------------------------------------------------------
// Version & help
// ---------------------------------------------------------------------------

describe("--version", () => {
  it("prints the package version", async () => {
    const { exitCode, out } = await runCli(["--version"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain(__PKG_VERSION__);
  });
});

describe("--help", () => {
  it("exits 0 and lists top-level subcommands", async () => {
    const { exitCode, out } = await runCli(["--help"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("constellation");
    expect(out).toContain("node");
    expect(out).toContain("relay");
    expect(out).toContain("hub");
  });
});

describe("relay --help", () => {
  it("lists relay subcommands", async () => {
    const { exitCode, out } = await runCli(["relay", "--help"], dir);
    expect(exitCode).toBe(0);
    for (const sub of ["login", "logout", "executors", "shares", "filters", "hub-shares"]) {
      expect(out).toContain(sub);
    }
    // Removed with the relay's own accounts and sessions: those live in asterism now.
    for (const gone of ["sessions", "users", "account", "elevate", "promote"]) {
      expect(out).not.toContain(gone);
    }
  });
});

describe("hub --help", () => {
  it("lists hub subcommands", async () => {
    const { exitCode, out } = await runCli(["hub", "--help"], dir);
    expect(exitCode).toBe(0);
    for (const sub of ["register", "start", "status", "stop"]) {
      expect(out).toContain(sub);
    }
  });
});

// ---------------------------------------------------------------------------
// relay logout
// ---------------------------------------------------------------------------

describe("relay logout", () => {
  it("succeeds and prints logged out even when no session file exists", async () => {
    const { exitCode, out } = await runCli(["relay", "logout"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("Logged out.");
  });

  it("removes the session file when one exists", async () => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_abc",
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(existsSync(relaySessionPath(dir))).toBe(true);

    const { exitCode, out } = await runCli(["relay", "logout"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("Logged out.");
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// relay commands — no session
// ---------------------------------------------------------------------------

describe("relay commands without a session", () => {
  it.each([
    { cmd: ["relay", "status"] },
    { cmd: ["relay", "executors", "list"] },
    { cmd: ["relay", "shares", "list"] },
    { cmd: ["relay", "filters", "list"] },
  ])("$cmd exits 1 with 'Not logged in'", async ({ cmd }) => {
    const { exitCode, err } = await runCli(cmd, dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Not logged in");
  });
});

// ---------------------------------------------------------------------------
// relay commands — expired session (no refresh token)
// ---------------------------------------------------------------------------

describe("relay commands with expired session", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_expired",
      access_token_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
      // no refresh_token — silent refresh is skipped
    });
  });

  it.each([
    { cmd: ["relay", "status"] },
    { cmd: ["relay", "executors", "list"] },
    { cmd: ["relay", "shares", "list"] },
  ])("$cmd exits 1 with 'Session expired'", async ({ cmd }) => {
    const { exitCode, err } = await runCli(cmd, dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
  });
});

// ---------------------------------------------------------------------------
// relay status — authenticated API calls, session refresh, and error mapping
// ---------------------------------------------------------------------------

describe("relay status — valid session", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_valid",
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the status API and formats a multi-day uptime", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.example.com/api/status");
      return new Response(JSON.stringify({ status: "ok", uptime_seconds: 90061, version: "1.2.3" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Status:  ok");
    expect(out).toContain("Version: 1.2.3");
    expect(out).toContain("Uptime:  1d 1h 1m");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an insufficient_scope API error to an admin-privileges message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403 })
    ));

    const { exitCode, err } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("requires admin privileges");
  });

  it("tells the user to sign in again when the relay answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })
    ));

    const { exitCode, err } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("constellation relay login");
  });
});

describe("die()", () => {
  it("prints the error body before exiting, not after", async () => {
    // process.exit really does terminate the process before any pending
    // microtask runs — a throw-based mock (as the runCli() harness above
    // uses) would mask a die() that fires off res.json() without awaiting
    // it, since the unwind gives that pending promise a chance to flush.
    // Mocking exit as a plain no-op and asserting call order instead pins
    // down the actual ordering guarantee.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const res = new Response(JSON.stringify({ error: "insufficient_scope" }), { status: 403 });
    await die(res);

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(exitSpy.mock.invocationCallOrder[0]);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("falls back to a generic message when the body isn't JSON", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const res = new Response("not json", { status: 500 });
    await die(res);

    expect(errorSpy).toHaveBeenCalledWith("API error 500");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(exitSpy.mock.invocationCallOrder[0]);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("relay executors list — pagination", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_valid",
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to limit=100&offset=0 and prints nothing extra when everything fits on one page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.example.com/api/executors?limit=100&offset=0");
      return new Response(JSON.stringify({ data: [], total: 0, limit: 100, offset: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, err } = await runCli(["relay", "executors", "list"], dir);

    expect(exitCode).toBe(0);
    expect(err).toBe("");
  });

  it("forwards --limit/--offset to the request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.example.com/api/executors?limit=5&offset=10");
      return new Response(JSON.stringify({ data: [], total: 10, limit: 5, offset: 10 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runCli(["relay", "executors", "list", "--limit", "5", "--offset", "10"], dir);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns on stderr (not stdout) when more rows exist beyond the current page, in both human and --json output", async () => {
    const page = {
      data: [{ id: "e1", host: "h1", online: true, last_heartbeat_at: null, shares: [] }],
      total: 250,
      limit: 100,
      offset: 0,
    };

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));
    const human = await runCli(["relay", "executors", "list"], dir);
    expect(human.err).toContain("Showing 1 of 250 total");
    expect(human.err).toContain("--offset 1");
    expect(human.out).not.toContain("Showing");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));
    const json = await runCli(["relay", "executors", "list", "--json"], dir);
    expect(json.err).toContain("Showing 1 of 250 total");
    expect(() => JSON.parse(json.out)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// asterism fake: metadata, device flow and token endpoint
// ---------------------------------------------------------------------------

const RELAY = "https://relay.example.com";
const ISSUER = "https://auth.example.com";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Backend {
  /** Every request, in order, with its form body parsed. */
  calls: Array<{ url: string; form: Record<string, string>; auth: string | null; method: string }>;
  /** Answers the token endpoint. Default: a device-code success / refresh success. */
  token: (form: Record<string, string>) => Response;
  /** Answers GET/POST on relay paths other than metadata. */
  api: (path: string, init?: RequestInit) => Response;
}

function stubBackend(overrides: Partial<Pick<Backend, "token" | "api">> = {}): Backend {
  const backend: Backend = {
    calls: [],
    token: (form) => form["grant_type"] === "refresh_token"
      ? jsonRes(200, { access_token: "at-refreshed", token_type: "Bearer", expires_in: 600, refresh_token: "rt-rotated" })
      : jsonRes(200, { access_token: form["resource"] ? "at-device" : "?", token_type: "Bearer", expires_in: 600, refresh_token: "rt-first", scope: "relay offline_access" }),
    api: () => jsonRes(200, { status: "ok", uptime_seconds: 5, version: "9.9.9" }),
    ...overrides,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    backend.calls.push({ url: u, form, auth: headers["Authorization"] ?? null, method: init?.method ?? "GET" });
    if (u === `${RELAY}/.well-known/oauth-protected-resource/mcp`) return jsonRes(200, { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] });
    if (u === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonRes(200, { issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/oauth/device/code`, token_endpoint: `${ISSUER}/oauth/token` });
    }
    if (u === `${ISSUER}/oauth/device/code`) {
      return jsonRes(200, {
        device_code: "dc-1", user_code: "ABCD-2345", verification_uri: `${ISSUER}/oauth/device`,
        verification_uri_complete: `${ISSUER}/oauth/device?user_code=ABCD-2345`, expires_in: 900, interval: 5,
      });
    }
    if (u === `${ISSUER}/oauth/token`) return backend.token(form);
    if (u.startsWith(RELAY)) return backend.api(u.slice(RELAY.length), init);
    throw new Error(`unexpected fetch: ${u}`);
  }));
  return backend;
}

const issuedAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

// ---------------------------------------------------------------------------
// relay login — device flow against asterism, scope relay offline_access, cli client
// ---------------------------------------------------------------------------

describe("relay login", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("signs in with the cli client and persists an access token plus refresh token", async () => {
    const backend = stubBackend();
    const { exitCode, out } = await runCli(["relay", "--relay", RELAY, "login"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain(`Logged in to ${RELAY}`);
    expect(out).toContain("ABCD-2345");

    const device = backend.calls.find((c) => c.url === `${ISSUER}/oauth/device/code`)!;
    expect(device.form).toEqual({ client_id: `${RELAY}/clients/cli.json`, scope: "relay offline_access", resource: `${RELAY}/mcp` });
    const token = backend.calls.find((c) => c.url === `${ISSUER}/oauth/token`)!;
    expect(token.form).toMatchObject({ client_id: `${RELAY}/clients/cli.json`, resource: `${RELAY}/mcp`, device_code: "dc-1" });

    const session = loadRelaySession(dir);
    expect(session).toMatchObject({ relay_url: RELAY, issuer: ISSUER, access_token: "at-device", refresh_token: "rt-first" });
    // Absolute 30 days from sign-in.
    const days = (new Date(session.refresh_token_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("opens the browser only for a URL on the authorization server's origin", async () => {
    const { default: open } = await import("open");
    vi.mocked(open).mockClear();
    stubBackend();
    await runCli(["relay", "--relay", RELAY, "login"], dir);
    expect(open).toHaveBeenCalledWith(`${ISSUER}/oauth/device?user_code=ABCD-2345`);
  });

  it("exits 1 with a clear message when the sign-in is denied", async () => {
    stubBackend({ token: () => jsonRes(400, { error: "access_denied" }) });
    const { exitCode, err } = await runCli(["relay", "--relay", RELAY, "login"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("denied");
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session refresh
// ---------------------------------------------------------------------------

describe("relay status — expired session with a refresh token", () => {
  const refreshExpiry = issuedAt(20 * 86_400_000);
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: RELAY,
      issuer: ISSUER,
      access_token: "tok_old",
      access_token_expires_at: issuedAt(-3_600_000),
      refresh_token: "refresh_abc",
      refresh_token_expires_at: refreshExpiry,
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("refreshes with client_id and resource, persists the rotated refresh token, and retries the call", async () => {
    const backend = stubBackend();
    let persistedBeforeApiCall: string | undefined;
    const original = backend.api;
    backend.api = (path, init) => {
      persistedBeforeApiCall = loadRelaySession(dir).refresh_token;
      return original(path, init);
    };

    const { exitCode, out } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Uptime:  5s");
    const refresh = backend.calls.find((c) => c.form["grant_type"] === "refresh_token")!;
    expect(refresh.form).toEqual({
      grant_type: "refresh_token", refresh_token: "refresh_abc", client_id: `${RELAY}/clients/cli.json`, resource: `${RELAY}/mcp`,
    });
    const status = backend.calls.find((c) => c.url === `${RELAY}/api/status`)!;
    expect(status.auth).toBe("Bearer at-refreshed");
    // The rotated token was already on disk when the new access token was first used.
    expect(persistedBeforeApiCall).toBe("rt-rotated");
    const session = loadRelaySession(dir);
    expect(session.access_token).toBe("at-refreshed");
    // The 30-day limit is absolute: rotation does not extend it.
    expect(session.refresh_token_expires_at).toBe(refreshExpiry);
    expect(existsSync(relaySessionPath(dir) + ".lock")).toBe(false);
  });

  it("says 'Session expired' and drops the session when asterism answers invalid_grant", async () => {
    stubBackend({ token: () => jsonRes(400, { error: "invalid_grant", error_description: "Refresh token already used" }) });

    const { exitCode, err } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
    expect(err).toContain("constellation relay login");
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });

  it("does not delete the session or claim it expired on a transient server error", async () => {
    stubBackend({ token: () => jsonRes(503, {}) });
    const { exitCode, err } = await runCli(["relay", "status"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Could not refresh");
    expect(existsSync(relaySessionPath(dir))).toBe(true);
  });

  it("skips the refresh and reports expiry once past the 30-day absolute lifetime", async () => {
    writeRelaySession(dir, {
      relay_url: RELAY,
      issuer: ISSUER,
      access_token: "tok_old",
      access_token_expires_at: issuedAt(-3_600_000),
      refresh_token: "refresh_abc",
      refresh_token_expires_at: issuedAt(-1000),
    });
    const backend = stubBackend();
    const { exitCode, err } = await runCli(["relay", "status"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
    expect(backend.calls.some((c) => c.form["grant_type"] === "refresh_token")).toBe(false);
  });

  it("runs the device flow again when a person is at the terminal", async () => {
    const { default: open } = await import("open");
    vi.mocked(open).mockClear();
    const setTty = (v: boolean | undefined) => {
      Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: v, configurable: true });
    };
    setTty(true);
    try {
      const backend = stubBackend({
        token: (form) => form["grant_type"] === "refresh_token"
          ? jsonRes(400, { error: "invalid_grant" })
          : jsonRes(200, { access_token: "at-new-login", token_type: "Bearer", expires_in: 600, refresh_token: "rt-new" }),
      });
      const { exitCode, out, err } = await runCli(["relay", "status"], dir);
      expect(exitCode).toBe(0);
      expect(err).toContain("Signing in again");
      // The code and URL go to stderr here, so a command's own stdout (e.g. --json) stays clean.
      expect(err).toContain("ABCD-2345");
      expect(out).not.toContain("ABCD-2345");
      expect(loadRelaySession(dir).refresh_token).toBe("rt-new");
      expect(backend.calls.find((c) => c.url === `${RELAY}/api/status`)!.auth).toBe("Bearer at-new-login");
    } finally {
      setTty(undefined);
    }
  });
});

describe("relay status — pinned authorization server", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const expired = (extra: Record<string, unknown> = {}) => writeRelaySession(dir, {
    relay_url: RELAY, issuer: ISSUER, access_token: "tok_old", access_token_expires_at: issuedAt(-3_600_000),
    refresh_token: "refresh_abc", refresh_token_expires_at: issuedAt(20 * 86_400_000), ...extra,
  });

  it("refuses to refresh when the relay now names a different issuer, and keeps the session", async () => {
    expired({ issuer: "https://old-auth.example.com" });
    const backend = stubBackend();
    const { exitCode, err } = await runCli(["relay", "status"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("different authorization server");
    expect(err).toContain("relay login");
    // The refresh token never left: no token request, and the file is untouched.
    expect(backend.calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(false);
    expect(backend.calls.some((c) => c.url.startsWith(ISSUER))).toBe(false);
    expect(loadRelaySession(dir).refresh_token).toBe("refresh_abc");
  });

  it("does not start a new sign-in on its own when the issuer changed, even at a terminal", async () => {
    const setTty = (v: boolean | undefined) => {
      Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: v, configurable: true });
    };
    expired({ issuer: "https://old-auth.example.com" });
    const backend = stubBackend();
    setTty(true);
    try {
      const { exitCode } = await runCli(["relay", "status"], dir);
      expect(exitCode).toBe(1);
      expect(backend.calls.some((c) => c.url.endsWith("/oauth/device/code"))).toBe(false);
    } finally {
      setTty(undefined);
    }
  });

  it("treats a session written before the issuer was recorded as needing sign-in", async () => {
    expired({ issuer: undefined });
    const backend = stubBackend();
    const { exitCode, err } = await runCli(["relay", "status"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
    expect(backend.calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(false);
  });
});

describe("relay login — server-supplied text", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("warns instead of printing a bare off-origin URL, and does not open it", async () => {
    const { default: open } = await import("open");
    vi.mocked(open).mockClear();
    stubBackend();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === `${ISSUER}/oauth/device/code`) {
        return jsonRes(200, {
          device_code: "dc-1", user_code: "ABCD-2345", verification_uri: "https://evil.example/x",
          verification_uri_complete: "https://evil.example/x\u001b[2J", expires_in: 900, interval: 5,
        });
      }
      return real(url, init);
    }));
    const { exitCode, out } = await runCli(["relay", "--relay", RELAY, "login"], dir);
    expect(exitCode).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(out).toContain("WARNING");
    expect(out).not.toContain("\u001b");
  });

  it("refuses a user code that is not asterism's format", async () => {
    const real = stubBackend();
    void real;
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === `${ISSUER}/oauth/device/code`) {
        return jsonRes(200, {
          device_code: "dc-1", user_code: "\u001b[2JFAKE", verification_uri: `${ISSUER}/oauth/device`,
          verification_uri_complete: `${ISSUER}/oauth/device`, expires_in: 900, interval: 5,
        });
      }
      return inner(url, init);
    }));
    const { exitCode, out, err } = await runCli(["relay", "--relay", RELAY, "login"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("malformed user_code");
    expect(out).not.toContain("FAKE");
  });

  it("strips control characters from an error description", async () => {
    stubBackend({ token: () => jsonRes(400, { error: "invalid_scope\u001b[2J", error_description: "x" }) });
    const { err } = await runCli(["relay", "--relay", RELAY, "login"], dir);
    expect(err).not.toContain("\u001b");
  });

  it("strips control characters from a relay API error body", async () => {
    writeRelaySession(dir, { relay_url: RELAY, issuer: ISSUER, access_token: "t", access_token_expires_at: issuedAt(3_600_000) });
    stubBackend({ api: () => jsonRes(500, { error: "\u001b[2J\u0085\u202eboom" }) });
    const { err } = await runCli(["relay", "status"], dir);
    expect(err).toContain("boom");
    // eslint-disable-next-line no-control-regex -- asserting control characters were stripped
    expect(err).not.toMatch(/[\u001b\u0085\u202e]/);
  });
});

describe("relay logout — revocation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const session = () => writeRelaySession(dir, {
    relay_url: RELAY, issuer: ISSUER, access_token: "t", access_token_expires_at: issuedAt(3_600_000),
    refresh_token: "rt-live", refresh_token_expires_at: issuedAt(20 * 86_400_000),
  });
  const withRevocation = (backend: Backend, revoke: (form: Record<string, string>) => Response) => {
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === `${ISSUER}/.well-known/oauth-authorization-server`) {
        return jsonRes(200, { issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/oauth/device/code`, token_endpoint: `${ISSUER}/oauth/token`, revocation_endpoint: `${ISSUER}/oauth/revoke` });
      }
      if (u === `${ISSUER}/oauth/revoke`) {
        const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
        backend.calls.push({ url: u, form, auth: null, method: "POST" });
        return revoke(form);
      }
      return inner(url, init);
    }));
  };

  it("revokes the refresh token at asterism with the cli client_id, then deletes the file", async () => {
    session();
    const backend = stubBackend();
    withRevocation(backend, () => new Response(null, { status: 200 }));
    const { exitCode, out } = await runCli(["relay", "logout"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("Logged out.");
    const revoke = backend.calls.find((c) => c.url === `${ISSUER}/oauth/revoke`)!;
    expect(revoke.form).toMatchObject({ token: "rt-live", client_id: `${RELAY}/clients/cli.json` });
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });

  it("still deletes the file, with a note, when revocation fails", async () => {
    session();
    const backend = stubBackend();
    withRevocation(backend, () => jsonRes(500, {}));
    const { exitCode, out, err } = await runCli(["relay", "logout"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("Logged out.");
    expect(err).toContain("Could not revoke");
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });

  it("does not send the token anywhere if the relay now names another issuer", async () => {
    writeRelaySession(dir, {
      relay_url: RELAY, issuer: "https://old-auth.example.com", access_token: "t", access_token_expires_at: issuedAt(3_600_000),
      refresh_token: "rt-live",
    });
    const backend = stubBackend();
    withRevocation(backend, () => new Response(null, { status: 200 }));
    const { exitCode } = await runCli(["relay", "logout"], dir);
    expect(exitCode).toBe(0);
    expect(backend.calls.some((c) => c.form["token"] === "rt-live")).toBe(false);
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });
});

describe("relay status — concurrent refreshes", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spends the refresh token once when two CLI processes race", async () => {
    writeRelaySession(dir, {
      relay_url: RELAY, issuer: ISSUER, access_token: "tok_old", access_token_expires_at: issuedAt(-3_600_000),
      refresh_token: "refresh_abc", refresh_token_expires_at: issuedAt(20 * 86_400_000),
    });
    const backend = stubBackend();
    // Two commands at once, as two processes would: the second must wait on the lock, re-read the
    // rotated session, and find it fresh, not present the spent token again.
    const [a, b] = await Promise.all([runCli(["relay", "status"], dir), runCli(["relay", "status"], dir)]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(backend.calls.filter((c) => c.form["grant_type"] === "refresh_token")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// relay executors revoke — confirmation prompt gating a destructive action
// ---------------------------------------------------------------------------

describe("relay executors revoke", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_valid",
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(mockedConfirm).mockReset();
  });

  it("does not call the API when the user declines the confirmation", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "executors", "revoke", "exec-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes the token when the user confirms", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/executors/exec-1/token");
      expect(opts?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "executors", "revoke", "exec-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Token revoked.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("relay filters remove", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_valid",
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(mockedConfirm).mockReset();
  });

  it("does not call the API when the user declines the confirmation", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "filters", "remove", "filter-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the filter when the user confirms", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/filters/filter-1");
      expect(opts?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "filters", "remove", "filter-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Filter removed.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// admin commands — a per-command step-up (scope "relay admin", no offline_access), never stored
// ---------------------------------------------------------------------------

describe("admin step-up", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: RELAY, access_token: "tok_session", access_token_expires_at: issuedAt(3_600_000),
      refresh_token: "rt-session", refresh_token_expires_at: issuedAt(20 * 86_400_000),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(mockedConfirm).mockReset();
  });

  const stepUpToken = () => jsonRes(200, { access_token: "at-admin", token_type: "Bearer", expires_in: 300, scope: "relay admin" });

  it("hub-shares list runs a second device flow for scope 'relay admin' and uses that token for the call", async () => {
    const backend = stubBackend({
      token: stepUpToken,
      api: () => jsonRes(200, {
        data: [{
          executor_id: "e1", executor_host: "hub-1", share: "docs", reported_path: "/srv/docs", updated_at: "x",
          permission_blob: { default: "none", overrides: [{ sub: "u-1", access: "read" }, { group: "eng", access: "write" }] },
        }],
        total: 1, limit: 100, offset: 0,
      }),
    });

    const { exitCode, out } = await runCli(["relay", "hub-shares", "list"], dir);

    expect(exitCode).toBe(0);
    const device = backend.calls.find((c) => c.url === `${ISSUER}/oauth/device/code`)!;
    expect(device.form).toEqual({ client_id: `${RELAY}/clients/cli.json`, scope: "relay admin", resource: `${RELAY}/mcp` });
    expect(device.form["scope"]).not.toContain("offline_access");
    expect(backend.calls.find((c) => c.url === `${RELAY}/api/admin/hub-shares?limit=100&offset=0`)!.auth).toBe("Bearer at-admin");
    // New override shapes: a user by sub, a group by name.
    expect(out).toContain("overrides: u-1=read, group:eng=write");
    // The admin token and its (absent) refresh token never reach disk.
    const onDisk = readFileSync(relaySessionPath(dir), "utf8");
    expect(onDisk).not.toContain("at-admin");
    expect(loadRelaySession(dir)).toMatchObject({ access_token: "tok_session", refresh_token: "rt-session" });
  });

  it("explains a denied step-up", async () => {
    stubBackend({ token: () => jsonRes(400, { error: "access_denied" }) });
    const { exitCode, err } = await runCli(["relay", "hub-shares", "list"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("admin group");
  });

  it("token create --shared steps up after the confirmation and prints the token", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const backend = stubBackend({
      token: stepUpToken,
      api: () => jsonRes(201, { token: "hub-secret", token_id: "t1", created_at: "now" }),
    });
    const { exitCode, out } = await runCli(["relay", "token", "create", "--shared"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("hub-secret");
    expect(backend.calls.find((c) => c.url === `${RELAY}/api/tokens/shared`)!.auth).toBe("Bearer at-admin");
  });

  it("does not step up when the user declines the confirmation", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(false);
    const backend = stubBackend();
    const { exitCode, out } = await runCli(["relay", "token", "create", "--shared"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(backend.calls).toHaveLength(0);
  });
});
