import { Command } from "commander";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import open from "open";
import { poll, assertSecureRelayUrl } from "@constellation/shared";
import { loadHubConfig, validateHubConfig } from "./config.js";
import { getpwnam } from "./identity.js";
import { runHub, sourceEnvFile } from "./index.js";
import { checkSharePath } from "./paths.js";

// ---------------------------------------------------------------------------
// Register all hub commands
// ---------------------------------------------------------------------------

const DEFAULT_HUB_CONFIG = "/etc/constellation/hub.yaml";

function defaultConfigPath(): string {
  return process.env["CONSTELLATION_HUB_CONFIG"] ?? DEFAULT_HUB_CONFIG;
}

export function registerHubCommands(program: Command): void {
  const hub = program
    .command("hub")
    .description("Manage the Constellation hub");

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  hub
    .command("register")
    .description("Register this machine as a hub (requires admin approval)")
    .requiredOption("--relay <url>", "Relay URL", process.env["RELAY_URL"])
    .option("--host-name <name>", "Host name for this hub", hostname())
    .option("--env-file <path>", "Path to write CONSTELLATION_HUB_TOKEN", "/etc/constellation/hub.env")
    .action(async (opts: { relay: string; hostName: string; envFile: string }) => {
      const { relay: relayUrl, hostName, envFile } = opts;

      if (!relayUrl) {
        console.error("Error: --relay is required (or set RELAY_URL)");
        process.exit(1);
      }

      if (!hostName || hostName.length > 63) {
        console.error("Error: host name must be 1–63 characters");
        process.exit(1);
      }

      console.log(`\nRegistering hub '${hostName}' with relay: ${relayUrl}`);
      console.log("An admin must approve this request in the browser.\n");

      const dcRes = await fetch(`${relayUrl}/oauth/device/code`, {
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
        async ({ intervalMs, setIntervalMs }) => {
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
            if (body.error === "slow_down") { setIntervalMs(intervalMs + 5000); return null; }
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

      console.log(`Hub '${result.host}' registered successfully.`);
      console.log(`Token written to: ${envFile}`);
      console.log(`\nSet CONSTELLATION_HUB_TOKEN from this file before starting the hub,`);
      console.log(`or pass --env-file to 'constellation hub start'.`);
    });

  // -------------------------------------------------------------------------
  // validate-config
  // -------------------------------------------------------------------------

  hub
    .command("validate-config")
    .description("Validate a hub config file (dry run)")
    .option("--config-file <path>", `Path to hub config file (default: ${DEFAULT_HUB_CONFIG}, or $CONSTELLATION_HUB_CONFIG)`, defaultConfigPath())
    .action(async (opts: { configFile: string }) => {
      let cfg;
      try {
        cfg = loadHubConfig(opts.configFile);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      const result = validateHubConfig(cfg);
      let hasError = !result.ok;

      // Check share paths exist on disk and are canonical absolute paths
      for (const share of cfg.shares) {
        const result = await checkSharePath(share.name, share.path);
        if (!result.ok) {
          console.error(`Error: ${result.error}`);
          hasError = true;
        }
      }

      // Check context_file is readable when set and no inline instructions override it
      for (const share of cfg.shares) {
        if (!share.instructions && share.context_file) {
          try {
            readFileSync(share.context_file, "utf8");
          } catch (err) {
            console.error(`Error: share '${share.name}' context_file '${share.context_file}' could not be read: ${(err as Error).message}`);
            hasError = true;
          }
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
      const hasTokenInEnv = !!process.env["CONSTELLATION_HUB_TOKEN"];
      const hasEnvFile = !!cfg.env_file;
      if (!hasTokenInEnv && !hasEnvFile) {
        console.error("Error: CONSTELLATION_HUB_TOKEN is not set and no env_file is configured");
        hasError = true;
      }

      for (const w of result.warnings) console.warn(`Warning: ${w}`);
      for (const e of result.errors) console.error(`Error: ${e}`);

      if (!hasError) {
        console.log(`Config '${opts.configFile}' is valid.`);
        console.log(`  hub_name: ${cfg.hub_name}`);
        console.log(`  relay_url: ${cfg.relay_url}`);
        console.log(`  shares: ${cfg.shares.map((s) => s.name).join(", ")}`);
      } else {
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  hub
    .command("start")
    .description("Start the hub service")
    .option("--config-file <path>", `Path to hub config file (default: ${DEFAULT_HUB_CONFIG}, or $CONSTELLATION_HUB_CONFIG)`, defaultConfigPath())
    .action(async (opts: { configFile: string }) => {
      await runHub(opts.configFile);
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  hub
    .command("status")
    .description("Show hub config and share status")
    .option("--config-file <path>", `Path to hub config file (default: ${DEFAULT_HUB_CONFIG}, or $CONSTELLATION_HUB_CONFIG)`, defaultConfigPath())
    .option("--json", "Output as JSON")
    .action((opts: { configFile: string; json?: boolean }) => {
      let cfg;
      try {
        cfg = loadHubConfig(opts.configFile);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      const out = {
        hub_name: cfg.hub_name,
        relay_url: cfg.relay_url,
        shares: cfg.shares.map((s) => ({ name: s.name, path: s.path, default_access: s.permissions.default })),
      };

      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Hub name: ${out.hub_name}`);
        console.log(`Relay:    ${out.relay_url}`);
        console.log(`Shares:`);
        for (const s of out.shares) {
          console.log(`  ${s.name} → ${s.path} [${s.default_access}]`);
        }
      }
    });

  // -------------------------------------------------------------------------
  // install — generate systemd unit for the hub
  // -------------------------------------------------------------------------

  hub
    .command("install")
    .description("Print a systemd unit file for the hub (system-level)")
    .option("--config-file <path>", `Path to hub config file (default: ${DEFAULT_HUB_CONFIG}, or $CONSTELLATION_HUB_CONFIG)`, defaultConfigPath())
    .option("--unit-name <name>", "Systemd unit name", "constellation-hub")
    .option("--user <user>", "Service user to run as (must have CAP_SETUID/CAP_SETGID)", "constellation")
    .action((opts: { configFile: string; unitName: string; user: string }) => {
      const isPkg = (process as typeof process & { pkg?: unknown }).pkg !== undefined;
      const execLine = isPkg
        ? `${process.execPath} hub start --config-file ${opts.configFile}`
        : `${process.execPath} ${process.argv[1]} hub start --config-file ${opts.configFile}`;
      const unit = `[Unit]
Description=Constellation Hub
After=network.target nss-lookup.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
ExecStart=${execLine}
Restart=on-failure
RestartSec=5
Environment=CONSTELLATION_HUB_CONFIG=${opts.configFile}
# The service user needs CAP_SETUID and CAP_SETGID to spawn per-user subnodes.
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

  hub
    .command("stop")
    .description("Stop the hub (sends SIGTERM to the running process)")
    .option("--unit-name <name>", "Systemd unit name to stop", "constellation-hub")
    .action((opts: { unitName: string }) => {
      try {
        execFileSync("systemctl", ["stop", opts.unitName], { stdio: "inherit" });
      } catch {
        console.error(`Failed to stop ${opts.unitName} via systemctl.`);
        console.error("If the hub is not running as a systemd service, send SIGTERM to the hub process manually.");
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // rotate-token
  // -------------------------------------------------------------------------

  hub
    .command("rotate-token")
    .description("Request a new hub token from the relay and write it to the env file")
    .option("--config-file <path>", `Path to hub config file (default: ${DEFAULT_HUB_CONFIG}, or $CONSTELLATION_HUB_CONFIG)`, defaultConfigPath())
    .action(async (opts: { configFile: string }) => {
      let cfg;
      try {
        cfg = loadHubConfig(opts.configFile);
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

      const token = process.env["CONSTELLATION_HUB_TOKEN"];
      if (!token) {
        console.error("Error: CONSTELLATION_HUB_TOKEN is not set (check env_file or environment)");
        process.exit(1);
      }

      const wsUrl = cfg.relay_url.replace(/^http/, "ws") + "/executor/connect";

      try {
        assertSecureRelayUrl(wsUrl);
      } catch (err) {
        console.error("Error:", (err as Error).message);
        process.exit(1);
      }

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
        console.error("Manually set CONSTELLATION_HUB_TOKEN to the new value (not printed for security).");
        process.exit(1);
      }

      console.log("Restart the hub to reconnect with the new token.");
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

  // Preserve any existing env vars in the file and update/add CONSTELLATION_HUB_TOKEN.
  let existing: string[] = [];
  try {
    existing = readFileSync(envFile, "utf8").split("\n");
  } catch {
    // File doesn't exist yet.
  }

  const key = "CONSTELLATION_HUB_TOKEN";
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
