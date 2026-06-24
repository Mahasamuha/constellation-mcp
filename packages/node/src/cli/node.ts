import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import WebSocket from "ws";
import open from "open";
import {
  configDir,
  loadNodeConfig,
  loadPathsConfig,
  writeNodeConfig,
  writeNodeToken,
  writePathsConfig,
  buildConfigUpdatePaths,
  nodeYamlPath,
  pathsYamlPath,
  type NodeConfig,
} from "../config.js";
import {
  MAX_SHARE_INSTRUCTIONS_LENGTH,
  poll,
  confirm,
  assertSecureRelayUrl,
  requestRotateViaControlChannel,
  type PathEntry,
} from "@constellation/shared";
import {
  install,
  startService,
  stopService,
  restartService,
  serviceStatus,
  showLogs,
} from "./service.js";
import { runDaemon } from "../index.js";
import { maskToken } from "./util.js";

export function registerNodeCommands(program: Command): void {
  const node = program
    .command("node")
    .description("Manage the local Constellation node")
    .option("--config-dir <dir>", "Override config directory", process.env["CONSTELLATION_CONFIG_DIR"]);

  const getConfigDir = (): string => configDir(node.opts<{ configDir?: string }>().configDir);

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  node
    .command("init")
    .description("Authenticate and register this machine with a relay")
    .option("--relay <url>", "Relay URL")
    .action(async (opts: { relay?: string }) => {
      const relayUrl = opts.relay ?? process.env["RELAY_URL"];
      if (!relayUrl) {
        console.error("Error: --relay <url> is required");
        process.exit(1);
      }

      try {
        assertSecureRelayUrl(relayUrl.replace(/^http/, "ws"));
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }

      // Pass existing host (if already configured) so the consent page can pre-fill it.
      const existingHost = (() => {
        try { return loadNodeConfig(getConfigDir()).host; } catch { return undefined; }
      })();

      const dcResult = await requestDeviceCode(relayUrl, existingHost);
      if (!dcResult.ok) {
        console.error("Failed to start device flow:", dcResult.error);
        process.exit(1);
      }
      const dc = dcResult.data;

      console.log(`\nOpen the following URL to authenticate (opening browser automatically):`);
      console.log(`  ${dc.verification_uri_complete}\n`);
      console.log(`If the browser did not open, enter this code: ${dc.user_code}\n`);

      try { await open(dc.verification_uri_complete); } catch { /* ignore */ }

      const outcome = await pollDeviceToken(relayUrl, dc.device_code, dc.interval * 1000, dc.expires_in * 1000);

      if (outcome === null) {
        console.error("Timed out waiting for authentication.");
        process.exit(1);
      }
      if (outcome.kind === "denied") {
        console.error("\nAccess denied.");
        process.exit(1);
      }
      if (outcome.kind === "error") {
        console.error("\nDevice flow error:", outcome.message);
        process.exit(1);
      }

      const dir = getConfigDir();
      persistNodeRegistration(dir, relayUrl, outcome.access_token, outcome.host);

      console.log(`\nNode registered as '${outcome.host}'.`);
      console.log(`Config written to: ${dir}`);
      console.log(`Add paths with: constellation node paths add <share> <path>`);
    });

  // -------------------------------------------------------------------------
  // auth subcommands — internal, JSON-only primitives used by node-gui to
  // drive its own auth UI without reimplementing the device-code client.
  // Each prints exactly one JSON object to stdout and exits 0; the JSON
  // payload itself (not the exit code) carries the outcome, so a calling
  // process never has to choose between parsing stdout and parsing stderr.
  // -------------------------------------------------------------------------

  const auth = node.command("auth").description("Internal device-code auth primitives (used by node-gui)");

  auth
    .command("device-code")
    .description("Request a device code from the relay")
    .requiredOption("--relay <url>", "Relay URL")
    .action(async (opts: { relay: string }) => {
      try {
        assertSecureRelayUrl(opts.relay.replace(/^http/, "ws"));
      } catch (err) {
        console.log(JSON.stringify({ ok: false, error: (err as Error).message }));
        return;
      }
      const existingHost = (() => {
        try { return loadNodeConfig(getConfigDir()).host; } catch { return undefined; }
      })();
      console.log(JSON.stringify(await requestDeviceCode(opts.relay, existingHost)));
    });

  auth
    .command("complete")
    .description("Poll for device-code completion and persist the result")
    .requiredOption("--relay <url>", "Relay URL")
    .requiredOption("--device-code <code>", "Device code from 'node auth device-code'")
    .requiredOption("--interval <seconds>", "Poll interval in seconds")
    .requiredOption("--expires-in <seconds>", "Device code expiry in seconds")
    .action(async (opts: { relay: string; deviceCode: string; interval: string; expiresIn: string }) => {
      try {
        assertSecureRelayUrl(opts.relay.replace(/^http/, "ws"));
      } catch (err) {
        console.log(JSON.stringify({ status: "error", message: (err as Error).message }));
        return;
      }

      const outcome = await pollDeviceToken(
        opts.relay,
        opts.deviceCode,
        parseInt(opts.interval, 10) * 1000,
        parseInt(opts.expiresIn, 10) * 1000
      );

      if (outcome === null) {
        console.log(JSON.stringify({ status: "timeout" }));
        return;
      }
      if (outcome.kind === "denied") {
        console.log(JSON.stringify({ status: "error", message: "Access denied." }));
        return;
      }
      if (outcome.kind === "error") {
        console.log(JSON.stringify({ status: "error", message: outcome.message }));
        return;
      }

      persistNodeRegistration(getConfigDir(), opts.relay, outcome.access_token, outcome.host);
      console.log(JSON.stringify({ status: "success", host: outcome.host }));
    });

  // -------------------------------------------------------------------------
  // install / start / stop / restart
  // -------------------------------------------------------------------------

  node
    .command("install")
    .description("Register the node with the OS service manager")
    .action(() => {
      const exec = process.execPath === process.argv[0]
        ? process.argv[1]!  // running as compiled binary
        : `${process.execPath} ${process.argv[1]}`;
      install(exec as string);
    });

  node
    .command("start")
    .description("Start the node service")
    .option("--foreground", "Run in the foreground (invoked by the service manager)")
    .action((opts: { foreground?: boolean }) => {
      if (opts.foreground) {
        runDaemon(node.opts<{ configDir?: string }>().configDir);
      } else {
        startService();
      }
    });
  node.command("stop").description("Stop the node service").action(() => stopService());
  node.command("restart").description("Restart the node service").action(() => restartService());

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  node
    .command("status")
    .description("Show service state, relay connection, and path shares")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const dir = getConfigDir();
      let nodeCfg: NodeConfig | null = null;
      try { nodeCfg = loadNodeConfig(dir); } catch { /* not initialised */ }

      const paths = loadPathsConfig(dir).paths;
      const svcState = (() => { try { return serviceStatus(); } catch { return "unknown"; } })();

      const out = {
        service: svcState,
        relay_url: nodeCfg?.relay_url ?? null,
        host: nodeCfg?.host ?? null,
        shares: paths.map((p) => ({ share: p.share, path: p.path })),
      };

      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Service:    ${out.service}`);
        console.log(`Relay:      ${out.relay_url ?? "(not configured)"}`);
        console.log(`Host:       ${out.host ?? "(not configured)"}`);
        console.log(`Shares:     ${out.shares.length === 0 ? "(none)" : ""}`);
        for (const l of out.shares) console.log(`  ${l.share} → ${l.path}`);
      }
    });

  // -------------------------------------------------------------------------
  // sync, rotate, rename — connect directly to relay
  // -------------------------------------------------------------------------

  node
    .command("sync")
    .description("Push path shares to the relay (use after manually editing paths.yaml)")
    .action(async () => {
      await syncPaths(getConfigDir());
      console.log("Shares synced.");
    });

  node
    .command("rotate")
    .description("Request a new node token from the relay")
    .action(async () => {
      const ok = await confirm("Rotate the node token? If no daemon is running to confirm the reconnect, the node will be disconnected until you start the service with the new token.");
      if (!ok) { console.log("Cancelled."); return; }
      const dir = getConfigDir();

      // Prefer asking the running daemon to rotate on its own live connection — it
      // performs the full handshake itself and only reports success once it has
      // actually reconnected with the new token, no race, no side effect on the
      // daemon's connection. Opening a second WebSocket of our own here (the
      // fallback below) would otherwise evict the daemon's live connection outright,
      // since the relay allows only one per executor.
      const viaControl = await requestRotateViaControlChannel(dir);
      if (viaControl) {
        if (viaControl.ok) {
          console.log("Token rotated — the running node has reconnected with the new token.");
        } else {
          console.error("Error:", viaControl.error);
          process.exit(1);
        }
        return;
      }

      // No daemon reachable — nothing to evict, but also nothing to confirm the
      // reconnect for. Rotate directly and let the next `node start` pick it up.
      const result = await nodeControlCommand(dir, "rotate_token",
        () => ({ type: "rotate_token" }),
        "token_rotated", "rotate_token_error"
      );
      if (result && typeof result === "object" && "token" in result) {
        writeNodeToken(dir, (result as { token: string }).token);
        console.log("Token rotated. Start the node service to connect with the new token.");
      }
    });

  node
    .command("rename")
    .argument("<host>", "New host name")
    .description("Push a new host name to the relay")
    .action(async (host: string) => {
      const dir = getConfigDir();
      const result = await nodeControlCommand(dir, "update_host",
        () => ({ type: "update_host", host }),
        "update_host_ok", "update_host_error"
      );
      if (result) {
        const cfg = loadNodeConfig(dir);
        writeNodeConfig(dir, { ...cfg, host });
        console.log(`Host renamed to '${host}'.`);
      }
    });

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  node
    .command("logs")
    .description("Show node service logs")
    .option("-f, --follow", "Tail the log output")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((opts: { follow?: boolean; lines: string }) => {
      showLogs(!!opts.follow, parseInt(opts.lines, 10));
    });

  // -------------------------------------------------------------------------
  // config subcommands
  // -------------------------------------------------------------------------

  const cfg = node.command("config").description("View and edit node configuration");

  cfg
    .command("show")
    .description("Print current config (token masked)")
    .action(() => {
      const dir = getConfigDir();
      try {
        const nodeCfg = loadNodeConfig(dir);
        console.log("=== node.yaml ===");
        console.log(`relay_url: ${nodeCfg.relay_url}`);
        console.log(`node_token: ${maskToken(nodeCfg.node_token)}`);
        console.log(`host: ${nodeCfg.host}`);
        console.log(`max_file_size_kb: ${nodeCfg.max_file_size_kb}`);
      } catch {
        console.log("node.yaml not found — run 'constellation node init' first");
      }
      console.log("\n=== paths.yaml ===");
      const paths = loadPathsConfig(dir).paths;
      if (paths.length === 0) {
        console.log("(no paths configured)");
      } else {
        for (const p of paths) console.log(`- share: ${p.share}\n  path: ${p.path}`);
      }
    });

  cfg
    .command("edit")
    .description("Open config files in $EDITOR")
    .action(() => {
      const editor = process.env["EDITOR"] ?? "vi";
      const dir = getConfigDir();
      execFileSync(editor, [nodeYamlPath(dir), pathsYamlPath(dir)], { stdio: "inherit" });
    });

  cfg
    .command("path")
    .description("Print path to config directory")
    .action(() => console.log(getConfigDir()));

  cfg
    .command("set")
    .description("Update relay_url/max_file_size_kb without re-registering (used by node-gui's settings save)")
    .option("--relay-url <url>", "New relay URL")
    .option("--max-file-size-kb <n>", "New max file size in KB")
    .action((opts: { relayUrl?: string; maxFileSizeKb?: string }) => {
      const dir = getConfigDir();
      let nodeCfg: NodeConfig;
      try {
        nodeCfg = loadNodeConfig(dir);
      } catch {
        console.error("Error: node.yaml not found — run 'constellation node init' first");
        process.exit(1);
      }

      const update: Partial<NodeConfig> = {};
      if (opts.relayUrl) {
        try {
          assertSecureRelayUrl(opts.relayUrl.replace(/^http/, "ws"));
        } catch (err) {
          console.error("Error:", (err as Error).message);
          process.exit(1);
        }
        update.relay_url = opts.relayUrl;
      }
      if (opts.maxFileSizeKb) {
        const n = parseInt(opts.maxFileSizeKb, 10);
        if (!Number.isFinite(n) || n <= 0) {
          console.error("Error: --max-file-size-kb must be a positive integer");
          process.exit(1);
        }
        update.max_file_size_kb = n;
      }

      writeNodeConfig(dir, { ...nodeCfg, ...update });
      console.log("Config updated.");
    });

  // -------------------------------------------------------------------------
  // paths subcommands
  // -------------------------------------------------------------------------

  const paths = node.command("paths").description("Manage path shares");

  paths
    .command("list")
    .description("List configured path shares")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const entries = loadPathsConfig(getConfigDir()).paths;
      if (opts.json) {
        console.log(JSON.stringify(entries));
      } else {
        if (entries.length === 0) { console.log("(no paths configured)"); return; }
        for (const e of entries) console.log(`${e.share} → ${e.path}`);
      }
    });

  paths
    .command("add")
    .argument("<share>", "Share name")
    .argument("<path>", "Absolute path on this machine")
    .option("--instructions <text>", `Inline instructions surfaced to MCP clients (max ${MAX_SHARE_INSTRUCTIONS_LENGTH} characters)`)
    .description("Add a path share and sync to the relay")
    .action(async (share: string, pathArg: string, opts: { instructions?: string }) => {
      const dir = getConfigDir();
      const cfg = loadPathsConfig(dir);
      if (cfg.paths.some((p) => p.share === share)) {
        console.error(`Share '${share}' already exists. Remove it first.`);
        process.exit(1);
      }
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(pathArg);
      } catch {
        console.error(`Error: path '${pathArg}' does not exist.`);
        process.exit(1);
      }
      if (!statSync(resolvedPath).isDirectory()) {
        console.error(`Error: '${pathArg}' is not a directory.`);
        process.exit(1);
      }
      const entry: PathEntry = { share, path: resolvedPath };
      if (opts.instructions) entry.instructions = opts.instructions;
      const updatedPaths = [...cfg.paths, entry];
      // Sync to the relay before persisting locally — if the sync fails, nodeControlCommand
      // exits the process, leaving the local config untouched instead of silently drifting
      // ahead of what the relay knows about.
      await syncPaths(dir, updatedPaths);
      writePathsConfig(dir, { ...cfg, paths: updatedPaths });
      console.log(`Share '${share}' added and synced.`);
    });

  paths
    .command("remove")
    .argument("<share>", "Share to remove")
    .description("Remove a path share and sync to the relay")
    .action(async (share: string) => {
      const ok = await confirm(`Remove share '${share}'? MCP clients will lose access to it immediately.`);
      if (!ok) { console.log("Cancelled."); return; }
      const dir = getConfigDir();
      const cfg = loadPathsConfig(dir);
      const updatedPaths = cfg.paths.filter((p) => p.share !== share);
      if (updatedPaths.length === cfg.paths.length) {
        console.error(`Share '${share}' not found.`);
        process.exit(1);
      }
      // Sync to the relay before persisting locally — see comment in `paths add`.
      await syncPaths(dir, updatedPaths);
      writePathsConfig(dir, { ...cfg, paths: updatedPaths });
      console.log(`Share '${share}' removed and synced.`);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function syncPaths(dir: string, candidatePaths?: PathEntry[]): Promise<void> {
  await nodeControlCommand(dir, "config_update",
    (_cfg, paths) => ({
      type: "config_update",
      paths: buildConfigUpdatePaths(candidatePaths ?? paths),
    }),
    "config_update_ok", "config_update_error"
  );
}

// ---------------------------------------------------------------------------
// Device-code flow — shared by `node init` (human terminal output) and the
// `node auth` subcommands (JSON output, used by node-gui as a subprocess) so
// there's exactly one implementation of the relay device-code client and one
// implementation of "persist a registration to disk."
// ---------------------------------------------------------------------------

interface DeviceCodeInfo {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type DeviceCodeResult =
  | { ok: true; data: DeviceCodeInfo }
  | { ok: false; error: string };

async function requestDeviceCode(relayUrl: string, existingHost?: string): Promise<DeviceCodeResult> {
  const dcParams: Record<string, string> = { scope: "agent:register" };
  if (existingHost) dcParams["host"] = existingHost;

  const dcRes = await fetch(`${relayUrl}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(dcParams),
  });
  if (!dcRes.ok) return { ok: false, error: await dcRes.text() };
  return { ok: true, data: await dcRes.json() as DeviceCodeInfo };
}

type DeviceTokenOutcome =
  | { kind: "denied" }
  | { kind: "error"; message: string }
  | { kind: "success"; access_token: string; host: string };

/** Polls until the device code is approved/denied/errors, or returns null on timeout. */
async function pollDeviceToken(
  relayUrl: string,
  deviceCode: string,
  intervalMs: number,
  timeoutMs: number
): Promise<DeviceTokenOutcome | null> {
  return poll<DeviceTokenOutcome>(
    async ({ intervalMs: currentIntervalMs, setIntervalMs }) => {
      const r = await fetch(`${relayUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
        }),
      });
      if (r.status === 400) {
        const body = await r.json() as { error: string };
        if (body.error === "authorization_pending") return null;
        if (body.error === "slow_down") { setIntervalMs(currentIntervalMs + 5000); return null; }
        if (body.error === "access_denied") return { kind: "denied" };
        return { kind: "error", message: body.error };
      }
      if (!r.ok) return null;
      const data = await r.json() as { access_token: string; host: string };
      return { kind: "success", access_token: data.access_token, host: data.host };
    },
    intervalMs,
    timeoutMs
  );
}

function persistNodeRegistration(dir: string, relayUrl: string, accessToken: string, host: string): void {
  writeNodeConfig(dir, {
    relay_url: relayUrl,
    node_token: accessToken,
    host,
    max_file_size_kb: 100,
  });
  // Create an empty paths.yaml if it doesn't exist.
  try { loadPathsConfig(dir); } catch {
    writePathsConfig(dir, { paths: [] });
  }
}

// ---------------------------------------------------------------------------
// Helper: connect to relay, send a control message, await response, return.
// ---------------------------------------------------------------------------

async function nodeControlCommand(
  dir: string,
  cmdName: string,
  buildMsg: (cfg: NodeConfig, paths: PathEntry[]) => object,
  successType: string,
  errorType: string | null
): Promise<object | null> {
  const cfg = loadNodeConfig(dir);
  const paths = loadPathsConfig(dir).paths;
  const wsUrl = cfg.relay_url.replace(/^http/, "ws") + "/executor/connect";

  try {
    assertSecureRelayUrl(wsUrl);
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${cfg.node_token}` },
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out waiting for relay response to ${cmdName}`));
    }, 15_000);

    ws.on("open", () => ws.send(JSON.stringify(buildMsg(cfg, paths))));

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        // Unlike relay-socket.ts's long-lived connection (which can just drop a bad
        // message and keep waiting), this is a one-shot command: nothing useful comes
        // from waiting out the rest of the timeout once we know the connection sent
        // something invalid.
        clearTimeout(timeout);
        ws.close();
        reject(new Error("Received an invalid (non-JSON) response from relay"));
        return;
      }
      if (msg["type"] === successType) {
        clearTimeout(timeout);
        ws.close();
        resolve(msg);
      } else if (errorType && msg["type"] === errorType) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(String(msg["error"])));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${cmdName} failed: ${err.message}`));
    });
  }).then((r) => r as object | null)
    .catch((err: Error) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}
