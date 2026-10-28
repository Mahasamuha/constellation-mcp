import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { Command } from "commander";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:net";
import { WebSocketServer, type WebSocket as WSClient } from "ws";
import { registerNodeCommands } from "./cli/node.js";
import {
  writeNodeConfig,
  writePathsConfig,
  loadPathsConfig,
  loadNodeConfig,
} from "./config.js";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";

import { confirm as mockedConfirm, startControlServer } from "@constellation/shared";

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
  program.name("constellation");

  registerNodeCommands(program);

  // --config-dir is declared on the `node` parent command — inject it right
  // after the subtree name so every test points at the temp config dir.
  const argv = args[0] === "node"
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
  // Default to "confirmed" so existing tests exercising paths remove/rotate (which
  // now prompt) don't need to know about confirm() at all; tests that specifically
  // care about the decline path override this per-test.
  vi.mocked(mockedConfirm).mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  await cleanTempDir(dir);
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe("node --help", () => {
  it("lists node subcommands", async () => {
    const { exitCode, out } = await runCli(["node", "--help"], dir);
    expect(exitCode).toBe(0);
    for (const sub of ["init", "start", "stop", "status", "paths", "config"]) {
      expect(out).toContain(sub);
    }
  });
});

// ---------------------------------------------------------------------------
// asterism / relay fakes for the sign-in and registration tests
// ---------------------------------------------------------------------------

const RELAY = "https://relay.example.com";
const ISSUER = "https://auth.example.com";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DEVICE_CODE_RESPONSE = {
  device_code: "dc-1", user_code: "ABCD-2345",
  verification_uri: `${ISSUER}/oauth/device`,
  verification_uri_complete: `${ISSUER}/oauth/device?user_code=ABCD-2345`,
  expires_in: 900, interval: 5,
};

interface FakeOpts {
  token?: () => Response;
  register?: () => Response;
  deviceCode?: () => Response;
}

/** Stubs fetch with a relay (metadata + /api/executors/register) and an asterism (metadata,
 * device authorization, token endpoint). Returns the recorded requests. */
function stubBackends(opts: FakeOpts = {}) {
  const calls: Array<{ url: string; body: string; auth: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, body: String(init?.body ?? ""), auth: headers["Authorization"] ?? null });
    switch (u) {
      case `${RELAY}/.well-known/oauth-protected-resource/mcp`:
        return jsonRes(200, { resource: `${RELAY}/mcp`, authorization_servers: [ISSUER] });
      case `${ISSUER}/.well-known/oauth-authorization-server`:
        return jsonRes(200, { issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/oauth/device/code`, token_endpoint: `${ISSUER}/oauth/token` });
      case `${ISSUER}/oauth/device/code`:
        return opts.deviceCode?.() ?? jsonRes(200, DEVICE_CODE_RESPONSE);
      case `${ISSUER}/oauth/token`:
        return opts.token?.() ?? jsonRes(200, { access_token: "at-node", token_type: "Bearer", expires_in: 3600, scope: "relay" });
      case `${RELAY}/api/executors/register`:
        return opts.register?.() ?? jsonRes(200, { access_token: "tok-new", token_type: "agent", host: JSON.parse(String(init?.body))["host"] });
      default:
        throw new Error(`unexpected fetch: ${u}`);
    }
  }));
  return calls;
}

// Instant polling: the device flow sleeps `interval` seconds before every poll. The mock targets
// cli-util itself because asterism-client imports sleep from there, not through the package index.
vi.mock("../../shared/src/cli-util.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/src/cli-util.js")>();
  return { ...actual, sleep: async () => {} };
});
vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));
import open from "open";
vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  return { ...actual, confirm: vi.fn() };
});

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(open).mockClear(); });

// ---------------------------------------------------------------------------
// node init — relay URL scheme validation
// ---------------------------------------------------------------------------

describe("node init — relay URL scheme validation", () => {
  it("rejects a plaintext http:// relay URL for a non-localhost host before doing anything else", async () => {
    const { exitCode, err } = await runCli(["node", "init", "--relay", "http://relay.example.com"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("http://");
    expect(() => loadNodeConfig(dir)).toThrow();
  });

  it("allows a plaintext http:// relay URL for localhost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(404, {})));
    const { exitCode, err } = await runCli(["node", "init", "--relay", "http://localhost:3000"], dir);
    // Scheme validation passes; the command fails later on the (mocked) metadata request instead.
    expect(exitCode).toBe(1);
    expect(err).not.toContain("Refusing to connect");
    expect(err).toContain("Failed to start sign-in");
  });

  it("allows a https:// relay URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(404, {})));
    const { exitCode, err } = await runCli(["node", "init", "--relay", RELAY], dir);
    expect(exitCode).toBe(1);
    expect(err).not.toContain("Refusing to connect");
    expect(err).toContain("Failed to start sign-in");
  });
});

describe("node init — registration", () => {
  it("signs in with the node client and scope relay, registers with the chosen host, and writes node.yaml", async () => {
    const calls = stubBackends();
    const { exitCode, out } = await runCli(["node", "init", "--relay", RELAY, "--host-name", "my-laptop"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Node registered as 'my-laptop'");
    expect(open).toHaveBeenCalledWith(DEVICE_CODE_RESPONSE.verification_uri_complete);

    const deviceReq = new URLSearchParams(calls.find((c) => c.url === `${ISSUER}/oauth/device/code`)!.body);
    expect(Object.fromEntries(deviceReq)).toEqual({
      client_id: `${RELAY}/clients/node.json`, scope: "relay", resource: `${RELAY}/mcp`,
    });
    const tokenReq = new URLSearchParams(calls.find((c) => c.url === `${ISSUER}/oauth/token`)!.body);
    expect(tokenReq.get("client_id")).toBe(`${RELAY}/clients/node.json`);
    expect(tokenReq.get("resource")).toBe(`${RELAY}/mcp`);

    const reg = calls.find((c) => c.url === `${RELAY}/api/executors/register`)!;
    expect(reg.auth).toBe("Bearer at-node");
    expect(JSON.parse(reg.body)).toEqual({ type: "node", host: "my-laptop" });

    const cfg = loadNodeConfig(dir);
    expect(cfg).toMatchObject({ relay_url: RELAY, node_token: "tok-new", host: "my-laptop" });
  });

  it("defaults the host to the previous registration's, then to the machine hostname", async () => {
    writeNodeConfig(dir, { relay_url: RELAY, node_token: "old", host: "kept-name", max_file_size_kb: 100 });
    let calls = stubBackends();
    await runCli(["node", "init", "--relay", RELAY], dir);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/register"))!.body).host).toBe("kept-name");

    const fresh = await makeTempDir();
    try {
      calls = stubBackends();
      await runCli(["node", "init", "--relay", RELAY], fresh);
      expect(JSON.parse(calls.find((c) => c.url.endsWith("/register"))!.body).host).toBe((await import("node:os")).hostname());
    } finally {
      await cleanTempDir(fresh);
    }
  });

  it("rejects a host name over 63 characters before starting sign-in", async () => {
    const calls = stubBackends();
    const { exitCode, err } = await runCli(["node", "init", "--relay", RELAY, "--host-name", "x".repeat(64)], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("1-63 characters");
    expect(calls).toHaveLength(0);
  });

  it("does not open a browser URL that is off the authorization server's origin", async () => {
    stubBackends({ deviceCode: () => jsonRes(200, { ...DEVICE_CODE_RESPONSE, verification_uri_complete: `${RELAY}/phish` }) });
    const { exitCode, out } = await runCli(["node", "init", "--relay", RELAY, "--host-name", "h"], dir);
    // The URL is still printed for the person to read, but never opened.
    expect(exitCode).toBe(0);
    expect(out).toContain(`${RELAY}/phish`);
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a refused registration without writing node.yaml", async () => {
    stubBackends({ register: () => jsonRes(403, { error: "insufficient_scope" }) });
    const { exitCode, err } = await runCli(["node", "init", "--relay", RELAY, "--host-name", "h"], dir);
    expect(exitCode).toBe(1);
    expect(err).toContain("insufficient_scope");
    expect(() => loadNodeConfig(dir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// node auth device-code / complete — internal JSON primitives used by
// node-gui as a subprocess instead of reimplementing the device-code client.
// ---------------------------------------------------------------------------

describe("node auth device-code", () => {
  it("prints a JSON error (exit 0) for a non-localhost http:// relay, never reaching fetch", async () => {
    const { exitCode, out } = await runCli(["node", "auth", "device-code", "--relay", "http://relay.example.com"], dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: expect.stringContaining("http://") });
  });

  it("prints asterism's device-code response as JSON on success", async () => {
    stubBackends();
    const { exitCode, out } = await runCli(["node", "auth", "device-code", "--relay", RELAY], dir);
    expect(exitCode).toBe(0);
    // Plus the issuer to pin and the only URL a caller may open.
    expect(JSON.parse(out)).toEqual({
      ok: true,
      data: { ...DEVICE_CODE_RESPONSE, issuer: ISSUER, open_url: DEVICE_CODE_RESPONSE.verification_uri_complete },
    });
  });

  it("emits open_url null when the verification URL is off the issuer's origin", async () => {
    stubBackends({ deviceCode: () => jsonRes(200, { ...DEVICE_CODE_RESPONSE, verification_uri_complete: "https://evil.example/x" }) });
    const { out } = await runCli(["node", "auth", "device-code", "--relay", RELAY], dir);
    expect(JSON.parse(out)).toMatchObject({ ok: true, data: { open_url: null, issuer: ISSUER } });
  });

  it.each(["HTTP://relay.example.com", "ftp://relay.example.com", "file:///etc/passwd"])("refuses %s", async (relay) => {
    const { out } = await runCli(["node", "auth", "device-code", "--relay", relay], dir);
    expect(JSON.parse(out)).toMatchObject({ ok: false });
  });

  it("prints a JSON error when asterism rejects the request", async () => {
    stubBackends({ deviceCode: () => jsonRes(400, { error: "invalid_client" }) });
    const { exitCode, out } = await runCli(["node", "auth", "device-code", "--relay", RELAY], dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: expect.stringContaining("invalid_client") });
  });

  it.each(["my laptop", "caf\u00e9", "a/b"])("rejects host name %j before any request", async (name) => {
    const calls = stubBackends();
    const { out } = await runCli(["node", "auth", "device-code", "--relay", RELAY, "--host-name", name], dir);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: expect.stringContaining("--host-name") });
    expect(calls).toHaveLength(0);
  });

  it("prints a JSON error for an invalid host name", async () => {
    const { exitCode, out } = await runCli(["node", "auth", "device-code", "--relay", RELAY, "--host-name", "x".repeat(64)], dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: expect.stringContaining("1-63") });
  });
});

describe("node auth complete", () => {
  const completeArgs = ["node", "auth", "complete", "--relay", RELAY, "--device-code", "dc-1", "--issuer", ISSUER, "--interval", "1", "--expires-in", "30"];

  it("prints a JSON error (exit 0) for a non-localhost http:// relay, never reaching fetch", async () => {
    const { exitCode, out } = await runCli(
      ["node", "auth", "complete", "--relay", "http://relay.example.com", "--device-code", "dc-1", "--issuer", ISSUER, "--interval", "1", "--expires-in", "30"],
      dir
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "error", message: expect.stringContaining("http://") });
  });

  it("polls, registers, persists node.yaml/paths.yaml, and prints success", async () => {
    stubBackends();
    const { exitCode, out } = await runCli([...completeArgs, "--host-name", "new-host"], dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: "success", host: "new-host" });
    const cfg = loadNodeConfig(dir);
    expect(cfg.node_token).toBe("tok-new");
    expect(cfg.host).toBe("new-host");
    expect(cfg.relay_url).toBe(RELAY);
  });

  it("refuses to poll when the relay now names a different issuer than the one the code came from", async () => {
    const calls = stubBackends();
    const args = completeArgs.map((a) => (a === ISSUER ? "https://old-auth.example.com" : a));
    const { exitCode, out } = await runCli(args, dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ status: "error", message: expect.stringContaining("different authorization server") });
    expect(calls.some((c) => c.url.startsWith(ISSUER) )).toBe(false);
    expect(() => loadNodeConfig(dir)).toThrow();
  });

  it("requires --issuer", async () => {
    stubBackends();
    const args = completeArgs.filter((a, i) => a !== "--issuer" && completeArgs[i - 1] !== "--issuer");
    const { exitCode, err } = await runCli(args, dir);
    expect(exitCode).not.toBe(0);
    expect(err).toContain("--issuer");
  });

  it.each([["NaN", "30"], ["0", "30"], ["-1", "30"], ["1", "0"], ["1", "abc"], ["1.5", "30"]])(
    "refuses --interval %s --expires-in %s without polling",
    async (interval, expiresIn) => {
      const calls = stubBackends();
      const args = completeArgs.map((a) => (a === "1" ? interval : a === "30" ? expiresIn : a));
      const { out } = await runCli(args, dir);
      expect(JSON.parse(out)).toMatchObject({ status: "error", message: expect.stringContaining("positive whole numbers") });
      expect(calls).toHaveLength(0);
    }
  );

  it("does not follow a redirect from the register endpoint", async () => {
    const calls = stubBackends();
    const inner = globalThis.fetch;
    let init2: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/executors/register")) init2 = init;
      return inner(url, init);
    }));
    await runCli(completeArgs, dir);
    expect(init2?.redirect).toBe("error");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("prints a JSON error when the user denies the request", async () => {
    stubBackends({ token: () => jsonRes(400, { error: "access_denied" }) });
    const { exitCode, out } = await runCli(completeArgs, dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: "error", message: "Access denied." });
  });

  it("prints a timeout result when the code expires", async () => {
    stubBackends({ token: () => jsonRes(400, { error: "expired_token" }) });
    const { exitCode, out } = await runCli(completeArgs, dir);
    expect(exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual({ status: "timeout" });
  });
});

// ---------------------------------------------------------------------------
// node config set
// ---------------------------------------------------------------------------

describe("node config set", () => {
  beforeEach(() => {
    writeNodeConfig(dir, { relay_url: "https://relay.example.com", node_token: "tok-original", host: "test-host", max_file_size_kb: 100 });
  });

  it("updates relay_url and max_file_size_kb while preserving node_token/host", async () => {
    const { exitCode } = await runCli(
      ["node", "config", "set", "--relay-url", "https://new-relay.example.com", "--max-file-size-kb", "250"],
      dir
    );
    expect(exitCode).toBe(0);
    const cfg = loadNodeConfig(dir);
    expect(cfg.relay_url).toBe("https://new-relay.example.com");
    expect(cfg.max_file_size_kb).toBe(250);
    expect(cfg.node_token).toBe("tok-original");
    expect(cfg.host).toBe("test-host");
  });

  it("rejects a non-localhost http:// relay URL and leaves node.yaml untouched", async () => {
    const { exitCode, err } = await runCli(
      ["node", "config", "set", "--relay-url", "http://new-relay.example.com"],
      dir
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("http://");
    expect(loadNodeConfig(dir).relay_url).toBe("https://relay.example.com");
  });

  it("errors when node.yaml does not exist yet", async () => {
    const freshDir = await makeTempDir();
    try {
      const { exitCode, err } = await runCli(["node", "config", "set", "--max-file-size-kb", "50"], freshDir);
      expect(exitCode).toBe(1);
      expect(err).toContain("node init");
    } finally {
      await cleanTempDir(freshDir);
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

  it("shows configured path shares", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefghijklmnop",
      host: "sirius",
      max_file_size_kb: 100,
    });
    writePathsConfig(dir, { paths: [{ share: "home", path: "/home/user" }] });
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
    expect(parsed).toMatchObject({ relay_url: null, host: null, shares: [] });
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

  it("includes path shares in output", async () => {
    writeNodeConfig(dir, {
      relay_url: "https://relay.example.com",
      node_token: "tok_abcdefgh",
      host: "sirius",
      max_file_size_kb: 100,
    });
    writePathsConfig(dir, { paths: [{ share: "src", path: "/home/user/src" }] });
    const { exitCode, out } = await runCli(["node", "status", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.shares).toHaveLength(1);
    expect(parsed.shares[0]).toMatchObject({ share: "src", path: "/home/user/src" });
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
        { share: "src", path: "/home/user/src" },
        { share: "docs", path: "/home/user/docs" },
      ],
    });
    const { exitCode, out } = await runCli(["node", "paths", "list", "--json"], dir);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out) as Array<{ share: string; path: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ share: "src", path: "/home/user/src" });
    expect(parsed[1]).toMatchObject({ share: "docs", path: "/home/user/docs" });
  });

  it("lists paths in human-readable format", async () => {
    writePathsConfig(dir, { paths: [{ share: "myrepo", path: "/home/user/myrepo" }] });
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

  it("exits 1 when share already exists", async () => {
    writePathsConfig(dir, { paths: [{ share: "existing", path: "/some/path" }] });
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
  it("exits 1 when share does not exist", async () => {
    const { exitCode, err } = await runCli(
      ["node", "paths", "remove", "nonexistent"],
      dir,
    );
    expect(exitCode).toBe(1);
    expect(err).toContain("not found");
  });

  it("does not touch local config when the user declines the confirmation", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(false);
    writePathsConfig(dir, { paths: [{ share: "existing", path: "/some/path" }] });

    const { exitCode, out } = await runCli(["node", "paths", "remove", "existing"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(loadPathsConfig(dir).paths.map((p) => p.share)).toEqual(["existing"]);
  });
});

// ---------------------------------------------------------------------------
// node paths add/remove — local config only persists after a successful sync
// ---------------------------------------------------------------------------

describe("node paths add/remove — relay sync ordering", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function respondOnce(responseType: string): void {
    wss.once("connection", (ws: WSClient) => {
      ws.once("message", () => {
        ws.send(JSON.stringify({ type: responseType, error: "rejected" }));
      });
    });
  }

  function configureNode(): void {
    writeNodeConfig(dir, { relay_url: `http://localhost:${port}`, node_token: "tok", host: "test-host" });
  }

  it("persists the new share locally once the relay confirms the sync", async () => {
    configureNode();
    writePathsConfig(dir, { paths: [] });
    respondOnce("config_update_ok");

    const { exitCode } = await runCli(["node", "paths", "add", "myrepo", dir], dir);

    expect(exitCode).toBe(0);
    expect(loadPathsConfig(dir).paths.map((p) => p.share)).toEqual(["myrepo"]);
  });

  it("does not persist the new share locally when the relay rejects the sync", async () => {
    configureNode();
    writePathsConfig(dir, { paths: [] });
    respondOnce("config_update_error");

    const { exitCode } = await runCli(["node", "paths", "add", "myrepo", dir], dir);

    expect(exitCode).toBe(1);
    expect(loadPathsConfig(dir).paths).toEqual([]);
  });

  it("does not remove the local share when the relay rejects the sync", async () => {
    configureNode();
    writePathsConfig(dir, { paths: [{ share: "existing", path: "/some/path" }] });
    respondOnce("config_update_error");

    const { exitCode } = await runCli(["node", "paths", "remove", "existing"], dir);

    expect(exitCode).toBe(1);
    expect(loadPathsConfig(dir).paths.map((p) => p.share)).toEqual(["existing"]);
  });
});

// ---------------------------------------------------------------------------
// node rotate — prefers asking a live daemon over its control channel (no
// race, no eviction of the daemon's connection); falls back to a direct
// relay connection only when no daemon is reachable.
// ---------------------------------------------------------------------------

describe("node rotate — live daemon reachable via control channel", () => {
  let controlServer: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  });

  it("asks the running daemon to rotate instead of connecting to the relay directly", async () => {
    const rotateToken = vi.fn().mockResolvedValue(undefined);
    controlServer = startControlServer(dir, { rotateToken });
    await new Promise<void>((resolve) => {
      if (controlServer.listening) resolve(); else controlServer.once("listening", resolve);
    });

    // Deliberately no node.yaml in this temp dir — the fallback path (nodeControlCommand)
    // requires one and would throw if reached, so a clean exit here is itself proof the
    // control-channel path short-circuited before ever falling back.
    const { exitCode, out } = await runCli(["node", "rotate"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("the running node has reconnected with the new token");
    expect(rotateToken).toHaveBeenCalledTimes(1);
  });

  it("reports the daemon's rotation failure instead of falling back", async () => {
    const rotateToken = vi.fn().mockRejectedValue(new Error("Timed out waiting for rotation to complete"));
    controlServer = startControlServer(dir, { rotateToken });
    await new Promise<void>((resolve) => {
      if (controlServer.listening) resolve(); else controlServer.once("listening", resolve);
    });

    const { exitCode, err } = await runCli(["node", "rotate"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("Timed out waiting for rotation to complete");
  });
});

describe("node rotate — no daemon running", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    port = (wss.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("falls back to a direct relay connection when no control file is present", async () => {
    writeNodeConfig(dir, { relay_url: `http://localhost:${port}`, node_token: "tok-original", host: "test-host" });
    wss.once("connection", (ws: WSClient) => {
      ws.once("message", () => ws.send(JSON.stringify({ type: "token_rotated", token: "tok-rotated" })));
    });

    const { exitCode, out } = await runCli(["node", "rotate"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Start the node service to connect with the new token");
    expect(loadNodeConfig(dir).node_token).toBe("tok-rotated");
  });

  it("does not attempt rotation when the user declines the confirmation", async () => {
    vi.mocked(mockedConfirm).mockResolvedValue(false);
    writeNodeConfig(dir, { relay_url: `http://localhost:${port}`, node_token: "tok-original", host: "test-host" });
    const connectionAttempted = vi.fn();
    wss.once("connection", connectionAttempted);

    const { exitCode, out } = await runCli(["node", "rotate"], dir);

    expect(exitCode).toBe(0);
    expect(out).toContain("Cancelled.");
    expect(connectionAttempted).not.toHaveBeenCalled();
    expect(loadNodeConfig(dir).node_token).toBe("tok-original");
  });

  it("fails cleanly instead of crashing on a non-JSON response from relay", async () => {
    writeNodeConfig(dir, { relay_url: `http://localhost:${port}`, node_token: "tok-original", host: "test-host" });
    wss.once("connection", (ws: WSClient) => {
      ws.once("message", () => ws.send("not json"));
    });

    const { exitCode, err } = await runCli(["node", "rotate"], dir);

    expect(exitCode).toBe(1);
    expect(err).toContain("Received an invalid (non-JSON) response from relay");
    expect(loadNodeConfig(dir).node_token).toBe("tok-original");
  });
});
