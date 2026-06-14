import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

declare const __PKG_VERSION__: string;
import { Command } from "commander";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { registerNodeCommands } from "./cli/node.js";
import { registerRelayCommands } from "./cli/relay.js";
import {
  writeNodeConfig,
  writePathsConfig,
  writeRelaySession,
  relaySessionPath,
} from "./config.js";
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
  });
});

describe("node --help", () => {
  it("lists node subcommands", async () => {
    const { exitCode, out } = await runCli(["node", "--help"], dir);
    expect(exitCode).toBe(0);
    for (const sub of ["init", "start", "stop", "status", "paths", "config"]) {
      expect(out).toContain(sub);
    }
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

// ---------------------------------------------------------------------------
// node config path
// ---------------------------------------------------------------------------

describe("node config path", () => {
  it("prints the config directory", async () => {
    const { exitCode, out } = await runCli(["node", "config", "path"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain(dir);
  });
});

// ---------------------------------------------------------------------------
// node config show
// ---------------------------------------------------------------------------

describe("node config show", () => {
  it("reports missing config when not initialised", async () => {
    const { exitCode, out } = await runCli(["node", "config", "show"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("not found");
  });

  it("prints relay_url and masked token when configured", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefghijklmnop",
      host: "sirius",
      max_file_size_kb: 100,
    });
    const { exitCode, out } = await runCli(["node", "config", "show"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("https://relay.example.com");
    expect(out).toContain("sirius");
    expect(out).toContain("tok_abcd");
    expect(out).not.toContain("tok_abcdefghijklmnop");
  });

  it("shows configured path labels", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefghijklmnop",
      host: "sirius",
      max_file_size_kb: 100,
    });
    writePathsConfig(dir, { paths: [{ label: "home", path: "/home/user" }] });
    const { exitCode, out } = await runCli(["node", "config", "show"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("home");
    expect(out).toContain("/home/user");
  });
});

// ---------------------------------------------------------------------------
// node status --json
// ---------------------------------------------------------------------------

describe("node status --json", () => {
  it("outputs valid JSON with null fields when not configured", async () => {
    const { exitCode, out } = await runCli(["node", "status", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ relay_url: null, host: null, labels: [] });
    expect(typeof parsed.service).toBe("string");
  });

  it("outputs relay_url and host when configured", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefgh",
      host: "sirius",
      max_file_size_kb: 100,
    });
    const { exitCode, out } = await runCli(["node", "status", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.relay_url).toBe("https://relay.example.com");
    expect(parsed.host).toBe("sirius");
  });

  it("includes path labels in output", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefgh",
      host: "sirius",
      max_file_size_kb: 100,
    });
    writePathsConfig(dir, { paths: [{ label: "src", path: "/home/user/src" }] });
    const { exitCode, out } = await runCli(["node", "status", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.labels).toHaveLength(1);
    expect(parsed.labels[0]).toMatchObject({ label: "src", path: "/home/user/src" });
  });
});

// ---------------------------------------------------------------------------
// node paths list
// ---------------------------------------------------------------------------

describe("node paths list", () => {
  it("shows message when no paths configured", async () => {
    const { exitCode, out } = await runCli(["node", "paths", "list"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("no paths configured");
  });

  it("outputs empty array with --json when no paths", async () => {
    const { exitCode, out } = await runCli(["node", "paths", "list", "--json"], dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
  });

  it("lists configured paths with --json", async () => {
    writePathsConfig(dir, {
      paths: [
        { label: "src", path: "/home/user/src" },
        { label: "docs", path: "/home/user/docs" },
      ],
    });
    const { exitCode, out } = await runCli(["node", "paths", "list", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out) as Array<{ label: string; path: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ label: "src", path: "/home/user/src" });
    expect(parsed[1]).toMatchObject({ label: "docs", path: "/home/user/docs" });
  });

  it("lists paths in human-readable format", async () => {
    writePathsConfig(dir, { paths: [{ label: "myrepo", path: "/home/user/myrepo" }] });
    const { exitCode, out } = await runCli(["node", "paths", "list"], dir);
    expect(exitCode).toBe(0);
    expect(out).toContain("myrepo");
    expect(out).toContain("/home/user/myrepo");
  });
});

// ---------------------------------------------------------------------------
// node paths add — error cases (no network needed)
// ---------------------------------------------------------------------------

describe("node paths add — errors", () => {
  it("exits 1 when path does not exist", async () => {
    const { exitCode, err } = await runCli(
      ["node", "paths", "add", "myrepo", "/nonexistent/path/xyz123"],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("does not exist");
  });

  it("exits 1 when path is a file, not a directory", async () => {
    const filePath = join(dir, "notadir.txt");
    await fs.writeFile(filePath, "x");
    const { exitCode, err } = await runCli(
      ["node", "paths", "add", "myrepo", filePath],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("not a directory");
  });

  it("exits 1 when label already exists", async () => {
    writePathsConfig(dir, { paths: [{ label: "existing", path: "/some/path" }] });
    const { exitCode, err } = await runCli(
      ["node", "paths", "add", "existing", dir],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// node paths remove — error cases
// ---------------------------------------------------------------------------

describe("node paths remove — errors", () => {
  it("exits 1 when label does not exist", async () => {
    const { exitCode, err } = await runCli(
      ["node", "paths", "remove", "nonexistent"],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("not found");
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
