import { Command } from "commander";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import open from "open";
import { poll } from "./util.js";
import { loadSharedConfig, validateSharedConfig } from "../shared/config.js";
import { getpwnam } from "../shared/identity.js";
import { runSharedAgent, sourceEnvFile } from "../shared/index.js";
import { checkLabelPath } from "../shared/paths.js";

// ---------------------------------------------------------------------------
// Register all shared-agent commands
// ---------------------------------------------------------------------------

const DEFAULT_SHARED_AGENT_CONFIG = "/etc/constellation/shared-agent.yaml";

function defaultConfigPath(): string {
  return process.env["CONSTELLATION_SHARED_AGENT_CONFIG"] ?? DEFAULT_SHARED_AGENT_CONFIG;
}

export function registerSharedAgentCommands(program: Command, _getConfigDir: () => string): void {
  const sharedAgent = program
    .command("shared-agent")
    .description("Manage the Constellation shared agent");

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  sharedAgent
    .command("register")
    .description("Register this machine as a shared agent (requires admin approval)")
    .requiredOption("--broker-url <url>", "Broker URL", process.env["BROKER_URL"])
    .option("--host-name <name>", "Host name for this agent", hostname())
    .option("--env-file <path>", "Path to write CONSTELLATION_AGENT_TOKEN", "/etc/constellation/shared-agent.env")
    .action(async (opts: { brokerUrl: string; hostName: string; envFile: string }) => {
      const { brokerUrl, hostName, envFile } = opts;

      if (!brokerUrl) {
        console.error("Error: --broker-url is required (or set BROKER_URL)");
        process.exit(1);
      }

      if (!hostName || hostName.length > 63) {
        console.error("Error: host name must be 1–63 characters");
        process.exit(1);
      }

      console.log(`\nRegistering shared agent '${hostName}' with broker: ${brokerUrl}`);
      console.log("An admin must approve this request in the browser.\n");

      const dcRes = await fetch(`${brokerUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ scope: "agent:register:shared", host_name: hostName }),
      });
      if (!dcRes.ok) {
        console.error("Failed to start device flow:", await dcRes.text());
        process.exit(1);
      }
      const dc = await dcRes.json() as {
        device_code: string;
        user_code: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };

      console.log(`Share the following URL with an admin (opening browser automatically):`);
      console.log(`  ${dc.verification_uri_complete}\n`);
      console.log(`If the browser did not open, the admin should enter this code: ${dc.user_code}\n`);
      console.log("Waiting for admin approval...\n");
      try { await open(dc.verification_uri_complete); } catch { /* ignore */ }

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
              console.error("\nAccess denied. Ensure the approving user has admin privileges.");
              process.exit(1);
            }
            console.error("\nDevice flow error:", body.error);
            process.exit(1);
          }
          if (!r.ok) return null;
          return r.json() as Promise<{ access_token: string; token_type: string; host: string }>;
        },
        dc.interval * 1000,
        dc.expires_in * 1000
      );

      if (!result) {
        console.error("Timed out waiting for approval.");
        process.exit(1);
      }

      // Write the token to the env file. Never print the raw token value.
      writeEnvToken(envFile, result.access_token);
      warnIfEnvFileInsecure(envFile);

      console.log(`Shared agent '${result.host}' registered successfully.`);
      console.log(`Token written to: ${envFile}`);
      console.log(`\nSet CONSTELLATION_AGENT_TOKEN from this file before starting the agent,`);
      console.log(`or pass --env-file to 'constellation shared-agent start'.`);
    });

  // -------------------------------------------------------------------------
  // validate-config
  // -------------------------------------------------------------------------

  sharedAgent
    .command("validate-config")
    .description("Validate a shared agent config file (dry run)")
    .option("--config <path>", `Path to shared agent config file (default: ${DEFAULT_SHARED_AGENT_CONFIG}, or $CONSTELLATION_SHARED_AGENT_CONFIG)`, defaultConfigPath())
    .action(async (opts: { config: string }) => {
      let cfg;
      try {
        cfg = loadSharedConfig(opts.config);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      const result = validateSharedConfig(cfg);
      let hasError = !result.ok;

      // Check label paths exist on disk and are canonical absolute paths
      for (const label of cfg.labels) {
        const result = await checkLabelPath(label.name, label.path);
        if (!result.ok) {
          console.error(`Error: ${result.error}`);
          hasError = true;
        }
      }

      // Check user_map usernames resolve via getent
      for (const entry of cfg.identity.user_map) {
        const pw = await getpwnam(entry.local_username);
        if (!pw) {
          console.error(`Error: user_map entry for oidc_sub '${entry.oidc_sub}' maps to '${entry.local_username}' which does not exist on this system`);
          hasError = true;
        }
      }

      // Check token is available (env or env_file specified)
      const hasTokenInEnv = !!process.env["CONSTELLATION_AGENT_TOKEN"];
      const hasEnvFile = !!cfg.env_file;
      if (!hasTokenInEnv && !hasEnvFile) {
        console.error("Error: CONSTELLATION_AGENT_TOKEN is not set and no env_file is configured");
        hasError = true;
      }

      for (const w of result.warnings) console.warn(`Warning: ${w}`);
      for (const e of result.errors) console.error(`Error: ${e}`);

      if (!hasError) {
        console.log(`Config '${opts.config}' is valid.`);
        console.log(`  agent_name: ${cfg.agent_name}`);
        console.log(`  broker_url: ${cfg.broker_url}`);
        console.log(`  labels: ${cfg.labels.map((l) => l.name).join(", ")}`);
      } else {
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  sharedAgent
    .command("start")
    .description("Start the shared agent service")
    .option("--config <path>", `Path to shared agent config file (default: ${DEFAULT_SHARED_AGENT_CONFIG}, or $CONSTELLATION_SHARED_AGENT_CONFIG)`, defaultConfigPath())
    .action(async (opts: { config: string }) => {
      await runSharedAgent(opts.config);
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  sharedAgent
    .command("status")
    .description("Show shared agent config and label status")
    .option("--config <path>", `Path to shared agent config file (default: ${DEFAULT_SHARED_AGENT_CONFIG}, or $CONSTELLATION_SHARED_AGENT_CONFIG)`, defaultConfigPath())
    .option("--json", "Output as JSON")
    .action((opts: { config: string; json?: boolean }) => {
      let cfg;
      try {
        cfg = loadSharedConfig(opts.config);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      const out = {
        agent_name: cfg.agent_name,
        broker_url: cfg.broker_url,
        labels: cfg.labels.map((l) => ({ name: l.name, path: l.path, default_access: l.permissions.default })),
      };

      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Agent name: ${out.agent_name}`);
        console.log(`Broker:     ${out.broker_url}`);
        console.log(`Labels:`);
        for (const l of out.labels) {
          console.log(`  ${l.name} → ${l.path} [${l.default_access}]`);
        }
      }
    });

  // -------------------------------------------------------------------------
  // install — generate systemd unit for the shared agent
  // -------------------------------------------------------------------------

  sharedAgent
    .command("install")
    .description("Print a systemd unit file for the shared agent (system-level)")
    .option("--config <path>", `Path to shared agent config file (default: ${DEFAULT_SHARED_AGENT_CONFIG}, or $CONSTELLATION_SHARED_AGENT_CONFIG)`, defaultConfigPath())
    .option("--unit-name <name>", "Systemd unit name", "constellation-shared-agent")
    .option("--user <user>", "Service user to run as (must have CAP_SETUID/CAP_SETGID)", "constellation")
    .action((opts: { config: string; unitName: string; user: string }) => {
      const isPkg = (process as typeof process & { pkg?: unknown }).pkg !== undefined;
      const execLine = isPkg
        ? `${process.execPath} shared-agent start --config ${opts.config}`
        : `${process.execPath} ${process.argv[1]} shared-agent start --config ${opts.config}`;
      const unit = `[Unit]
Description=Constellation Shared Agent
After=network.target nss-lookup.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
ExecStart=${execLine}
Restart=on-failure
RestartSec=5
Environment=CONSTELLATION_SHARED_AGENT_CONFIG=${opts.config}
# The service user needs CAP_SETUID and CAP_SETGID to spawn per-user subagents.
AmbientCapabilities=CAP_SETUID CAP_SETGID
CapabilityBoundingSet=CAP_SETUID CAP_SETGID
NoNewPrivileges=no
ProtectSystem=strict
ReadWritePaths=/var/log/constellation

[Install]
WantedBy=multi-user.target
`;
      console.log(unit);
      console.log("# Install steps:");
      console.log(`# sudo tee /etc/systemd/system/${opts.unitName}.service > /dev/null << 'EOF'`);
      console.log("# <paste the unit above>");
      console.log("# EOF");
      console.log(`# sudo systemctl daemon-reload`);
      console.log(`# sudo systemctl enable --now ${opts.unitName}`);
    });

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  sharedAgent
    .command("stop")
    .description("Stop the shared agent (sends SIGTERM to the running process)")
    .option("--unit-name <name>", "Systemd unit name to stop", "constellation-shared-agent")
    .action((opts: { unitName: string }) => {
      try {
        execFileSync("systemctl", ["stop", opts.unitName], { stdio: "inherit" });
      } catch {
        console.error(`Failed to stop ${opts.unitName} via systemctl.`);
        console.error("If the agent is not running as a systemd service, send SIGTERM to the agent process manually.");
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // rotate-token
  // -------------------------------------------------------------------------

  sharedAgent
    .command("rotate-token")
    .description("Request a new agent token from the broker and write it to the env file")
    .option("--config <path>", `Path to shared agent config file (default: ${DEFAULT_SHARED_AGENT_CONFIG}, or $CONSTELLATION_SHARED_AGENT_CONFIG)`, defaultConfigPath())
    .action(async (opts: { config: string }) => {
      let cfg;
      try {
        cfg = loadSharedConfig(opts.config);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      // Source env_file to get the current token
      if (cfg.env_file) {
        try {
          sourceEnvFile(cfg.env_file);
        } catch { /* env_file may not exist */ }
      }

      const token = process.env["CONSTELLATION_AGENT_TOKEN"];
      if (!token) {
        console.error("Error: CONSTELLATION_AGENT_TOKEN is not set (check env_file or environment)");
        process.exit(1);
      }

      const wsUrl = cfg.broker_url.replace(/^http/, "ws") + "/agent/connect";

      const newToken = await new Promise<string | null>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
        const timeout = setTimeout(() => { ws.terminate(); resolve(null); }, 15_000);

        ws.on("open", () => ws.send(JSON.stringify({ type: "rotate_token" })));
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg["type"] === "token_rotated" && typeof msg["token"] === "string") {
            clearTimeout(timeout);
            ws.close();
            resolve(msg["token"]);
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          console.error("Error:", err.message);
          resolve(null);
        });
      });

      if (!newToken) {
        console.error("Failed to rotate token (timeout or connection error)");
        process.exit(1);
      }

      if (cfg.env_file) {
        writeEnvToken(cfg.env_file, newToken);
        warnIfEnvFileInsecure(cfg.env_file);
        console.log(`Token rotated and written to: ${cfg.env_file}`);
      } else {
        console.error("No env_file configured — cannot persist new token.");
        console.error("Manually set CONSTELLATION_AGENT_TOKEN to the new value (not printed for security).");
        process.exit(1);
      }

      console.log("Restart the shared agent to reconnect with the new token.");
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeEnvToken(envFile: string, token: string): void {
  const dir = dirname(envFile);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist or be /etc (no write permission without sudo).
    // Let the writeFileSync below surface the real error.
  }

  // Preserve any existing env vars in the file and update/add CONSTELLATION_AGENT_TOKEN.
  let existing: string[] = [];
  try {
    existing = readFileSync(envFile, "utf8").split("\n");
  } catch {
    // File doesn't exist yet.
  }

  const key = "CONSTELLATION_AGENT_TOKEN";
  const updated = existing.filter((line) => !line.startsWith(`${key}=`) && line !== "");
  updated.push(`${key}=${token}`);

  writeFileSync(envFile, updated.join("\n") + "\n", { mode: 0o600 });
}

function warnIfEnvFileInsecure(envFile: string): void {
  try {
    const st = statSync(envFile);
    const mode = st.mode & 0o777;
    if (mode & 0o004) {
      console.warn(`\nWARNING: ${envFile} is world-readable (mode ${mode.toString(8)}).`);
      console.warn("Run: chmod 600 " + envFile);
    } else if (mode & 0o040) {
      console.warn(`\nWARNING: ${envFile} is group-readable (mode ${mode.toString(8)}).`);
      console.warn("Consider: chmod 600 " + envFile);
    }
  } catch {
    // If stat fails after writing, don't crash.
  }
}
