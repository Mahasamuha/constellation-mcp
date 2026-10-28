import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { startControlServer, type RotatableConnection } from "@constellation/shared";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import { registerHubCommands } from "./cli.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));
// Instant polling; the mock targets cli-util because asterism-client imports sleep from there.
vi.mock("../../shared/src/cli-util.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sleep: async () => {} };
});

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

describe("hub rotate-token — direct fallback", () => {
  it("refuses a malformed token from the relay and leaves the env file alone", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as { port: number }).port;
    wss.on("connection", (ws: WSClient) => {
      ws.once("message", () => ws.send(JSON.stringify({ type: "token_rotated", token: "x\nPATH=/evil" })));
    });
    const envFile = join(dir, "hub.env");
    const original = `CONSTELLATION_HUB_TOKEN=${"ab".repeat(32)}\n`;
    writeFileSync(envFile, original);
    const configPath = join(dir, "hub.yaml");
    writeFileSync(configPath, `relay_url: http://localhost:${port}\nhub_name: t\naudit_log: ${join(dir, "audit.jsonl")}\nenv_file: ${envFile}\nshares: []\n`);
    const saved = process.env["CONSTELLATION_HUB_TOKEN"];
    delete process.env["CONSTELLATION_HUB_TOKEN"];
    try {
      const { exitCode, err } = await runCli(["hub", "rotate-token", "--config-file", configPath]);
      expect(exitCode).toBe(1);
      expect(err).toContain("malformed");
      expect(readFileSync(envFile, "utf8")).toBe(original);
    } finally {
      if (saved !== undefined) process.env["CONSTELLATION_HUB_TOKEN"] = saved; else delete process.env["CONSTELLATION_HUB_TOKEN"];
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

describe("hub register", () => {
  const RELAY = "https://relay.example.com";
  const ISSUER = "https://auth.example.com";
  const HUB_TOKEN = "ab".repeat(32);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /** A relay and an asterism that approve at once; `register` answers the register call. */
  function stub(register: (init: RequestInit | undefined) => Response | Error, verificationUri = `${ISSUER}/oauth/device?user_code=ABCD-2345`) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      switch (String(url)) {
        case `${RELAY}/.well-known/oauth-protected-resource/mcp`: return json(200, { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] });
        case `${ISSUER}/.well-known/oauth-authorization-server`:
          return json(200, { issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/d`, token_endpoint: `${ISSUER}/t` });
        case `${ISSUER}/d`:
          return json(200, { device_code: "dc", user_code: "ABCD-2345", verification_uri: `${ISSUER}/oauth/device`, verification_uri_complete: verificationUri, expires_in: 900, interval: 5 });
        case `${ISSUER}/t`: return json(200, { access_token: "at-admin", expires_in: 300 });
        case `${RELAY}/api/executors/register`: {
          const r = register(init);
          if (r instanceof Error) throw r;
          return r;
        }
        default: throw new Error(`unexpected fetch ${String(url)}`);
      }
    }));
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it("registers through the shared helper (no redirects) and writes the token to the env file", async () => {
    let seen: RequestInit | undefined;
    stub((init) => { seen = init; return json(200, { access_token: HUB_TOKEN, host: "h1" }); });
    const envFile = join(dir, "hub.env");
    const { exitCode, out } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", envFile]);
    expect(exitCode).toBe(0);
    expect(out).toContain("Hub 'h1' registered");
    expect(seen?.redirect).toBe("error");
    expect(readFileSync(envFile, "utf8")).toBe(`CONSTELLATION_HUB_TOKEN=${HUB_TOKEN}\nCONSTELLATION_HUB_ISSUER=${ISSUER}\n`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(out).not.toContain(HUB_TOKEN);
  });

  it("requests the admin and register scopes", async () => {
    let scope = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === `${ISSUER}/d`) scope = new URLSearchParams(init?.body as URLSearchParams).get("scope") ?? "";
      switch (u) {
        case `${RELAY}/.well-known/oauth-protected-resource/mcp`: return json(200, { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] });
        case `${ISSUER}/.well-known/oauth-authorization-server`:
          return json(200, { issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/d`, token_endpoint: `${ISSUER}/t` });
        case `${ISSUER}/d`: return json(200, { device_code: "dc", user_code: "ABCD-2345", verification_uri: `${ISSUER}/oauth/device`, verification_uri_complete: `${ISSUER}/oauth/device?user_code=ABCD-2345`, expires_in: 900, interval: 5 });
        case `${ISSUER}/t`: return json(200, { access_token: "at-admin", expires_in: 300 });
        default: return json(200, { access_token: HUB_TOKEN, host: "h1" });
      }
    }));
    const { exitCode, out } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", join(dir, "hub.env")]);
    expect(exitCode).toBe(0);
    expect(scope).toBe("relay admin register");
    expect(out).toContain("fresh sign-in");
  });

  it("refuses a token that is not 64 lowercase hex characters, without writing the env file", async () => {
    stub(() => json(200, { access_token: `${HUB_TOKEN.slice(1)}\nPATH=/evil`, host: "h1" }));
    const envFile = join(dir, "hub.env");
    const { exitCode, err } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", envFile]);
    expect(exitCode).toBe(1);
    expect(err).toContain("malformed");
    expect(() => readFileSync(envFile)).toThrow();
  });

  it("keeps the env file's other lines when writing the token", async () => {
    stub(() => json(200, { access_token: HUB_TOKEN, host: "h1" }));
    const envFile = join(dir, "hub.env");
    writeFileSync(envFile, "# mine\nFOO=bar\nCONSTELLATION_HUB_TOKEN=old\n");
    await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", envFile]);
    expect(readFileSync(envFile, "utf8")).toBe(`# mine\nFOO=bar\nCONSTELLATION_HUB_TOKEN=${HUB_TOKEN}\nCONSTELLATION_HUB_ISSUER=${ISSUER}\n`);
  });

  it("pins a repeat registration to the recorded issuer unless --accept-new-issuer is given", async () => {
    stub(() => json(200, { access_token: HUB_TOKEN, host: "h1" }));
    const envFile = join(dir, "hub.env");
    writeFileSync(envFile, "CONSTELLATION_HUB_ISSUER=https://previous-auth.example.com\n");
    const refused = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", envFile]);
    expect(refused.exitCode).toBe(1);
    expect(refused.err).toContain("different authorization server");
    expect(refused.err).toContain("--accept-new-issuer");
    expect(readFileSync(envFile, "utf8")).toBe("CONSTELLATION_HUB_ISSUER=https://previous-auth.example.com\n");

    const accepted = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", envFile, "--accept-new-issuer"]);
    expect(accepted.exitCode).toBe(0);
    expect(readFileSync(envFile, "utf8")).toContain(`CONSTELLATION_HUB_ISSUER=${ISSUER}`);
  });

  it("reports a network failure on the register call instead of crashing", async () => {
    stub(() => new TypeError("fetch failed"));
    const { exitCode, err } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", join(dir, "hub.env")]);
    expect(exitCode).toBe(1);
    expect(err).toContain("Could not reach the relay to register");
  });

  it("strips control characters from the relay's refusal", async () => {
    stub(() => json(403, { error: "forbidden", error_description: "\u001b[2Jnope" }));
    const { exitCode, err } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", join(dir, "hub.env")]);
    expect(exitCode).toBe(1);
    expect(err).toContain("nope");
    expect(err).not.toContain("\u001b");
  });

  it("warns, and does not open the browser, for a verification URL off the issuer's origin", async () => {
    const { default: open } = await import("open");
    vi.mocked(open).mockClear();
    stub(() => json(200, { access_token: HUB_TOKEN, host: "h1" }), "https://evil.example/x");
    const { out } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "h1", "--env-file", join(dir, "hub.env")]);
    expect(out).toContain("WARNING");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a host name the relay would refuse, before sign-in", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { exitCode, err } = await runCli(["hub", "register", "--relay", RELAY, "--host-name", "my host"]);
    expect(exitCode).toBe(1);
    expect(err).toContain("--host-name");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an upper-case or unknown scheme before any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const relay of ["HTTP://relay.example.com", "ftp://relay.example.com"]) {
      const { exitCode, err } = await runCli(["hub", "register", "--relay", relay, "--host-name", "h1"]);
      expect(exitCode).toBe(1);
      expect(err).toContain("Refusing to connect");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
