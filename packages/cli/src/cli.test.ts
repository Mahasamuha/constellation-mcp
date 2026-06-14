import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

declare const __PKG_VERSION__: string;
import { Command } from "commander";
import { existsSync } from "node:fs";
import { registerNodeCommands } from "@constellation/node/cli";
import { registerRelayCommands } from "./cli/relay.js";
import { registerHubCommands } from "@constellation/hub/cli";
import { writeRelaySession, relaySessionPath } from "@constellation/node/config";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

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
    for (const sub of ["login", "logout", "executors", "labels", "filters", "sessions"]) {
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
    { cmd: ["relay", "labels", "list"] },
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
    { cmd: ["relay", "labels", "list"] },
  ])("$cmd exits 1 with 'Session expired'", async ({ cmd }) => {
    const { exitCode, err } = await runCli(cmd, dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("Session expired");
  });
});
