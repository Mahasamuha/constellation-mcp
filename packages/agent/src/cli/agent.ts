import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import WebSocket from "ws";
import open from "open";
import {
  loadAgentConfig,
  loadPathsConfig,
  writeAgentConfig,
  writeAgentToken,
  writePathsConfig,
  buildConfigUpdatePaths,
  agentYamlPath,
  pathsYamlPath,
  type AgentConfig,
} from "../config.js";
import { MAX_LABEL_INSTRUCTIONS_LENGTH, type PathEntry } from "@constellation/shared";
import {
  install,
  startService,
  stopService,
  restartService,
  serviceStatus,
  showLogs,
} from "./service.js";
import { runDaemon } from "../index.js";
import { poll, maskToken } from "./util.js";

export function registerAgentCommands(program: Command, getConfigDir: () => string): void {
  const agent = program.command("agent").description("Manage the local Constellation agent");

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  agent
    .command("init")
    .description("Authenticate and register this machine with a broker")
    .option("--broker <url>", "Broker URL")
    .action(async (opts: { broker?: string }) => {
      const brokerUrl = opts.broker ?? process.env["BROKER_URL"];
      if (!brokerUrl) {
        console.error("Error: --broker <url> is required");
        process.exit(1);
      }

      // Pass existing host (if already configured) so the consent page can pre-fill it.
      const existingHost = (() => {
        try { return loadAgentConfig(getConfigDir()).host; } catch { return undefined; }
      })();

      const dcParams: Record<string, string> = { scope: "agent:register" };
      if (existingHost) dcParams["host"] = existingHost;

      // Request a device code.
      const dcRes = await fetch(`${brokerUrl}/oauth/device/code`, {
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
          const r = await fetch(`${brokerUrl}/oauth/token`, {
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
      writeAgentConfig(dir, {
        broker_url: brokerUrl,
        agent_token: result.access_token,
        host: result.host,
        max_file_size_kb: 100,
      });
      // Create an empty paths.yaml if it doesn't exist.
      try { loadPathsConfig(dir); } catch {
        writePathsConfig(dir, { paths: [] });
      }

      console.log(`\nAgent registered as '${result.host}'.`);
      console.log(`Config written to: ${dir}`);
      console.log(`Add paths with: constellation agent paths add <label> <path>`);
    });

  // -------------------------------------------------------------------------
  // install / start / stop / restart
  // -------------------------------------------------------------------------

  agent
    .command("install")
    .description("Register the agent with the OS service manager")
    .action(() => {
      const exec = process.execPath === process.argv[0]
        ? process.argv[1]!  // running as compiled binary
        : `${process.execPath} ${process.argv[1]}`;
      install(exec as string);
    });

  agent
    .command("start")
    .description("Start the agent service")
    .option("--foreground", "Run in the foreground (invoked by the service manager)")
    .action((opts: { foreground?: boolean }) => {
      if (opts.foreground) {
        runDaemon((agent.opts() as { config?: string }).config);
      } else {
        startService();
      }
    });
  agent.command("stop").description("Stop the agent service").action(() => stopService());
  agent.command("restart").description("Restart the agent service").action(() => restartService());

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  agent
    .command("status")
    .description("Show service state, broker connection, and path labels")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const dir = getConfigDir();
      let agentCfg: AgentConfig | null = null;
      try { agentCfg = loadAgentConfig(dir); } catch { /* not initialised */ }

      const paths = loadPathsConfig(dir).paths;
      const svcState = (() => { try { return serviceStatus(); } catch { return "unknown"; } })();

      const out = {
        service: svcState,
        broker_url: agentCfg?.broker_url ?? null,
        host: agentCfg?.host ?? null,
        labels: paths.map((p) => ({ label: p.label, path: p.path })),
      };

      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Service:    ${out.service}`);
        console.log(`Broker:     ${out.broker_url ?? "(not configured)"}`);
        console.log(`Host:       ${out.host ?? "(not configured)"}`);
        console.log(`Labels:     ${out.labels.length === 0 ? "(none)" : ""}`);
        for (const l of out.labels) console.log(`  ${l.label} → ${l.path}`);
      }
    });

  // -------------------------------------------------------------------------
  // sync, rotate, rename — connect directly to broker
  // -------------------------------------------------------------------------

  agent
    .command("sync")
    .description("Push path labels to the broker (use after manually editing paths.yaml)")
    .action(async () => {
      await syncPaths(getConfigDir());
      console.log("Labels synced.");
    });

  agent
    .command("rotate")
    .description("Request a new agent token from the broker")
    .action(async () => {
      const dir = getConfigDir();
      const result = await agentControlCommand(dir, "rotate_token",
        () => ({ type: "rotate_token" }),
        "token_rotated", null
      );
      if (result && typeof result === "object" && "token" in result) {
        writeAgentToken(dir, (result as { token: string }).token);
        console.log("Token rotated. Restart the agent service to reconnect with the new token.");
      }
    });

  agent
    .command("rename")
    .argument("<host>", "New host name")
    .description("Push a new host name to the broker")
    .action(async (host: string) => {
      const dir = getConfigDir();
      const result = await agentControlCommand(dir, "update_host",
        () => ({ type: "update_host", host }),
        "update_host_ok", "update_host_error"
      );
      if (result) {
        const cfg = loadAgentConfig(dir);
        writeAgentConfig(dir, { ...cfg, host });
        console.log(`Host renamed to '${host}'.`);
      }
    });

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  agent
    .command("logs")
    .description("Show agent service logs")
    .option("-f, --follow", "Tail the log output")
    .option("--lines <n>", "Number of lines to show", "50")
    .action((opts: { follow?: boolean; lines: string }) => {
      showLogs(!!opts.follow, parseInt(opts.lines, 10));
    });

  // -------------------------------------------------------------------------
  // config subcommands
  // -------------------------------------------------------------------------

  const cfg = agent.command("config").description("View and edit agent configuration");

  cfg
    .command("show")
    .description("Print current config (token masked)")
    .action(() => {
      const dir = getConfigDir();
      try {
        const agentCfg = loadAgentConfig(dir);
        console.log("=== agent.yaml ===");
        console.log(`broker_url: ${agentCfg.broker_url}`);
        console.log(`agent_token: ${maskToken(agentCfg.agent_token)}`);
        console.log(`host: ${agentCfg.host}`);
        console.log(`max_file_size_kb: ${agentCfg.max_file_size_kb}`);
      } catch {
        console.log("agent.yaml not found — run 'constellation agent init' first");
      }
      console.log("\n=== paths.yaml ===");
      const paths = loadPathsConfig(dir).paths;
      if (paths.length === 0) {
        console.log("(no paths configured)");
      } else {
        for (const p of paths) console.log(`- label: ${p.label}\n  path: ${p.path}`);
      }
    });

  cfg
    .command("edit")
    .description("Open config files in $EDITOR")
    .action(() => {
      const editor = process.env["EDITOR"] ?? "vi";
      const dir = getConfigDir();
      execFileSync(editor, [agentYamlPath(dir), pathsYamlPath(dir)], { stdio: "inherit" });
    });

  cfg
    .command("path")
    .description("Print path to config directory")
    .action(() => console.log(getConfigDir()));

  // -------------------------------------------------------------------------
  // paths subcommands
  // -------------------------------------------------------------------------

  const paths = agent.command("paths").description("Manage path labels");

  paths
    .command("list")
    .description("List configured path labels")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const entries = loadPathsConfig(getConfigDir()).paths;
      if (opts.json) {
        console.log(JSON.stringify(entries));
      } else {
        if (entries.length === 0) { console.log("(no paths configured)"); return; }
        for (const e of entries) console.log(`${e.label} → ${e.path}`);
      }
    });

  paths
    .command("add")
    .argument("<label>", "Label name")
    .argument("<path>", "Absolute path on this machine")
    .option("--instructions <text>", `Inline instructions surfaced to MCP clients (max ${MAX_LABEL_INSTRUCTIONS_LENGTH} characters)`)
    .description("Add a path label and sync to the broker")
    .action(async (label: string, pathArg: string, opts: { instructions?: string }) => {
      const dir = getConfigDir();
      const cfg = loadPathsConfig(dir);
      if (cfg.paths.some((p) => p.label === label)) {
        console.error(`Label '${label}' already exists. Remove it first.`);
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
      const entry: PathEntry = { label, path: resolvedPath };
      if (opts.instructions) entry.instructions = opts.instructions;
      cfg.paths.push(entry);
      writePathsConfig(dir, cfg);
      await syncPaths(dir);
      console.log(`Label '${label}' added and synced.`);
    });

  paths
    .command("remove")
    .argument("<label>", "Label to remove")
    .description("Remove a path label and sync to the broker")
    .action(async (label: string) => {
      const dir = getConfigDir();
      const cfg = loadPathsConfig(dir);
      const before = cfg.paths.length;
      cfg.paths = cfg.paths.filter((p) => p.label !== label);
      if (cfg.paths.length === before) {
        console.error(`Label '${label}' not found.`);
        process.exit(1);
      }
      writePathsConfig(dir, cfg);
      await syncPaths(dir);
      console.log(`Label '${label}' removed and synced.`);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function syncPaths(dir: string): Promise<void> {
  await agentControlCommand(dir, "config_update",
    (_cfg, paths) => ({
      type: "config_update",
      paths: buildConfigUpdatePaths(paths),
    }),
    "config_update_ok", "config_update_error"
  );
}

// ---------------------------------------------------------------------------
// Helper: connect to broker, send a control message, await response, return.
// ---------------------------------------------------------------------------

async function agentControlCommand(
  dir: string,
  _cmdName: string,
  buildMsg: (cfg: AgentConfig, paths: PathEntry[]) => object,
  successType: string,
  errorType: string | null
): Promise<object | null> {
  const cfg = loadAgentConfig(dir);
  const paths = loadPathsConfig(dir).paths;
  const wsUrl = cfg.broker_url.replace(/^http/, "ws") + "/agent/connect";

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${cfg.agent_token}` },
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error("Timed out waiting for broker response"));
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
        console.error("Error:", msg["error"]);
        process.exit(1);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  }).then((r) => r as object | null)
    .catch((err: Error) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}
