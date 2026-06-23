import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

declare const __PKG_VERSION__: string;
import { Command } from "commander";
import { existsSync } from "node:fs";
import { registerNodeCommands } from "@constellation/node/cli";
import { registerRelayCommands, die } from "./cli/relay.js";
import { registerHubCommands } from "@constellation/hub/cli";
import { writeRelaySession, relaySessionPath, loadRelaySession } from "@constellation/node/config";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

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
    for (const sub of ["login", "logout", "executors", "shares", "filters", "sessions"]) {
      expect(out).toContain(sub);
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
    { cmd: ["relay", "sessions", "list"] },
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

  it("maps an ESCALATION_REQUIRED API error to an admin-privileges message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "ESCALATION_REQUIRED" }), { status: 403 })
    ));

    const { exitCode, err } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("requires admin privileges");
    expect(err).toContain("constellation relay elevate");
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

    const res = new Response(JSON.stringify({ error: "ESCALATION_REQUIRED" }), { status: 403 });
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

describe("relay status — expired session with a refresh token", () => {
  beforeEach(() => {
    writeRelaySession(dir, {
      relay_url: "https://relay.example.com",
      access_token: "tok_old",
      access_token_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
      refresh_token: "refresh_abc",
      refresh_token_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("silently refreshes, persists the new session, and retries the call", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://relay.example.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: "tok_new", expires_in: 3600 }), { status: 200 });
      }
      if (url === "https://relay.example.com/api/status") {
        return new Response(JSON.stringify({ status: "ok", uptime_seconds: 5, version: "9.9.9" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Uptime:  5s");
    expect(loadRelaySession(dir).access_token).toBe("tok_new");
    // refresh_token wasn't rotated by the relay in this response, so the old one is kept.
    expect(loadRelaySession(dir).refresh_token).toBe("refresh_abc");
  });

  it("falls through to 'Session expired' if the refresh request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://relay.example.com/oauth/token") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const { exitCode, err } = await runCli(["relay", "status"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
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

describe("relay sessions revoke", () => {
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

    const { exitCode, out } = await runCli(["relay", "sessions", "revoke", "sess-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes the session when the user confirms", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/sessions/sess-1");
      expect(opts?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "sessions", "revoke", "sess-1"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Session revoked.");
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
// relay users remove — regression test for a route mismatch (was calling
// DELETE /api/users/:username, a route the relay never registered, instead
// of POST /api/users/:username/deactivate) compounded by apiPost choking on
// the deactivate route's 204 No Content response.
// ---------------------------------------------------------------------------

describe("relay users remove", () => {
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

    const { exitCode, out } = await runCli(["relay", "users", "remove", "alice"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deactivates the user via POST .../deactivate and handles the 204 response", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/users/alice/deactivate");
      expect(opts?.method).toBe("POST");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "users", "remove", "alice"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("User 'alice' deactivated.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// relay account deactivate — same apiPost/204 bug as users remove above hit
// this command too; deleteRelaySession() ran after the now-fixed apiPost
// call, so the local session file was previously never being cleared either.
// ---------------------------------------------------------------------------

describe("relay account deactivate", () => {
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

  it("deactivates the account, handles the 204 response, and clears the local session", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(true);
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      expect(url).toBe("https://relay.example.com/api/account/deactivate");
      expect(opts?.method).toBe("POST");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(["relay", "account", "deactivate"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Account deactivated.");
    expect(existsSync(relaySessionPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// relay user promote/demote — --relay given on the `relay` parent must reach
// a subcommand nested two levels deep (relay -> user -> promote/demote).
// ---------------------------------------------------------------------------

describe("relay user promote/demote", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("promote resolves --relay from the `relay` parent, not just a local flag", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.example.com/api/admin/users/alice/promote");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(
      ["relay", "--relay", "https://relay.example.com", "user", "promote", "alice", "--admin-token", "tok"],
      dir
    );

    expect(exitCode).toBe(0);
    expect(out).toContain("promoted to admin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("demote resolves --relay from the `relay` parent, not just a local flag", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.example.com/api/admin/users/alice/demote");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { exitCode, out } = await runCli(
      ["relay", "--relay", "https://relay.example.com", "user", "demote", "alice", "--admin-token", "tok"],
      dir
    );

    expect(exitCode).toBe(0);
    expect(out).toContain("demoted to regular user");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("errors with the relay-URL hint when neither flag nor config provides one", async () => {
    const { exitCode, err } = await runCli(
      ["relay", "user", "promote", "alice", "--admin-token", "tok"],
      dir
    );

    expect(exitCode).toBe(1);
    expect(err).toContain("No relay URL configured");
  });
});
