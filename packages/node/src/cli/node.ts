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
import { MAX_SHARE_INSTRUCTIONS_LENGTH, poll, type PathEntry } from "@constellation/shared";
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

      // Pass existing host (if already configured) so the consent page can pre-fill it.
      const existingHost = (() => {
        try { return loadNodeConfig(getConfigDir()).host; } catch { return undefined; }
      })();

      const dcParams: Record<string, string> = { scope: "agent:register" };
      if (existingHost) dcParams["host"] = existingHost;

      // Request a device code.
      const dcRes = await fetch(`${relayUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(dcParams),
      });
      if (!dcRes.ok) {
        console.error("Failed to start device flow:", await dcRes.text());
        process.exit(1);
      }
      const dc = await dcRes.json() as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };

      console.log(`\nOpen the following URL to authenticate (opening browser automatically):`);
      console.log(`  ${dc.verification_uri_complete}\n`);
      console.log(`If the browser did not open, enter this code: ${dc.user_code}\n`);

      try { await open(dc.verification_uri_complete); } catch { /* ignore */ }

      // Poll for completion.
      const result = await poll(
        async () => {
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
            if (body.error === "access_denied") {
              console.error("\nAccess denied.");
              process.exit(1);
            }
            console.error("\nDevice flow error:", body.error);
            process.exit(1);
          }
          if (!r.ok) return null;
          return r.json() as Promise<{ access_token: string; host: string }>;
        },
        dc.interval * 1000,
        dc.expires_in * 1000
      );

      if (!result) {
        console.error("Timed out waiting for authentication.");
        process.exit(1);
      }

      const dir = getConfigDir();
      writeNodeConfig(dir, {
        relay_url: relayUrl,
        node_token: result.access_token,
        host: result.host,
        max_file_size_kb: 100,
      });
      // Create an empty paths.yaml if it doesn't exist.
      try { loadPathsConfig(dir); } catch {
        writePathsConfig(dir, { paths: [] });
      }

      console.log(`\nNode registered as '${result.host}'.`);
      console.log(`Config written to: ${dir}`);
      console.log(`Add paths with: constellation node paths add <share> <path>`);
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
      const dir = getConfigDir();
      const result = await nodeControlCommand(dir, "rotate_token",
        () => ({ type: "rotate_token" }),
        "token_rotated", "rotate_token_error"
      );
      if (result && typeof result === "object" && "token" in result) {
        writeNodeToken(dir, (result as { token: string }).token);
        console.log("Token rotated. Restart the node service to reconnect with the new token.");
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
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
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
