import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { startControlServer, type RotatableConnection } from "@constellation/shared";
import { registerHubCommands } from "./cli.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(dir);
});

function writeHubConfig(): string {
  const auditLog = join(dir, "audit.jsonl");
  const configPath = join(dir, "hub.yaml");
  writeFileSync(
    configPath,
    `relay_url: https://relay.example.com\nhub_name: test-hub\naudit_log: ${auditLog}\nshares: []\n`,
    "utf8"
  );
  return configPath;
}

async function runCli(args: string[]): Promise<{ exitCode: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => { outLines.push(a.map(String).join(" ")); });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => { errLines.push(a.map(String).join(" ")); });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new ExitError(typeof code === "number" ? code : 0);
  });

  const program = new Command();
  program.configureOutput({ writeOut: (s) => outLines.push(s), writeErr: (s) => errLines.push(s) });
  program.name("constellation");
  registerHubCommands(program);

  let exitCode = 0;
  try {
    await program.parseAsync(["node", "cli", ...args]);
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, out: outLines.join("\n"), err: errLines.join("\n") };
}

// This is the exact regression `hub rotate-token` had: it used to open a second
// WebSocket authenticated with the same, still-live token whenever it ran — which
// evicts a connected daemon's live connection. These tests prove the CLI checks
// for a reachable daemon first and, when one exists, never falls through to that
// direct-connection path at all.
describe("hub rotate-token — prefers the control channel over a second connection", () => {
  it("uses the running daemon's control channel and never falls through to a direct connection", async () => {
    const configPath = writeHubConfig();
    const rotateToken = vi.fn().mockResolvedValue(undefined);
    const stub: RotatableConnection = { rotateToken };
    // The CLI derives its control-file directory from dirname(cfg.audit_log), which
    // is `dir` itself here since audit.jsonl (per writeHubConfig()) lives directly
    // inside it — same directory the daemon side (runHub()) uses.
    const controlServer = startControlServer(dir, stub);
    await new Promise<void>((resolve) => {
      if (controlServer.listening) resolve(); else controlServer.once("listening", resolve);
    });

    try {
      const { exitCode, out } = await runCli(["hub", "rotate-token", "--config-file", configPath]);

      expect(exitCode).toBe(0);
      expect(out).toContain("No restart needed");
      expect(rotateToken).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => controlServer.close(() => resolve()));
    }
  });

  it("falls back to a direct connection (and fails cleanly with no token configured) when no daemon is reachable", async () => {
    const configPath = writeHubConfig();

    const { exitCode, err } = await runCli(["hub", "rotate-token", "--config-file", configPath]);

    expect(exitCode).toBe(1);
    expect(err).toContain("CONSTELLATION_HUB_TOKEN is not set");
  });
});
