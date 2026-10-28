import { Command } from "commander";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import open from "open";
import { AsterismError, EXECUTOR_TOKEN_PATTERN, writeEnvFileValue, readEnvFileValue, relayWsUrl, assertSecureHttpUrl, deviceSignIn, registerExecutor, checkHostName, deviceCodeLines, sanitizeForTerminal as t, requestRotateViaControlChannel } from "@constellation/shared";
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

/**
 * Disk-space stats for the filesystem holding the audit log's directory.
 * `AuditWriter` (audit.ts) fails open on ENOSPC/EACCES rather than blocking tool
 * calls, so this is the one signal an operator has for catching a filling disk before
 * audit coverage silently drops. Checks `dirname(auditLogPath)` specifically — not
 * some other convenient path — since that's the mount whose exhaustion actually
 * triggers the failure; on many production hosts /var/log is its own partition,
 * separate from the rest of the filesystem. Returns null (rather than throwing) if
 * the directory doesn't exist yet or can't be statted, since this is an informational
 * field that shouldn't fail the whole status command.
 */
function auditLogDiskStatus(auditLogPath: string): { dir: string; free_bytes: number; total_bytes: number } | null {
  const dir = dirname(auditLogPath);
  try {
    const stats = statfsSync(dir);
    return { dir, free_bytes: stats.bavail * stats.bsize, total_bytes: stats.blocks * stats.bsize };
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
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
    .option("--accept-new-issuer", "Trust the authorization server the relay names now, even though this hub registered with another")
    .action(async (opts: { relay: string; hostName: string; envFile: string; acceptNewIssuer?: boolean }) => {
      const { relay: relayUrl, hostName, envFile } = opts;

      if (!relayUrl) {
        console.error("Error: --relay is required (or set RELAY_URL)");
        process.exit(1);
      }

      const checkedHost = checkHostName(hostName ?? "");
      if (!checkedHost.ok) {
        console.error("Error:", checkedHost.error);
        process.exit(1);
      }

      try {
        assertSecureHttpUrl(relayUrl);
      } catch (err) {
        console.error("Error:", t((err as Error).message));
        process.exit(1);
      }

      console.log(`\nRegistering hub '${checkedHost.host}' with relay: ${relayUrl}`);
      console.log("An admin must approve this request in the browser, with a fresh sign-in: expect to be asked for");
      console.log("their password even if they are already signed in.\n");

      // Hub registration is admin-only: the sign-in asks for the step-up `admin` scope, which the
      // authorization server grants only to members of the admin group. That access token is used
      // once, here, to mint the hub token, and is not stored.
      // The authorization server this hub registered with before is recorded in the env file; a repeat
      // registration is pinned to it, so a relay that now names another one gets nothing.
      let expectedIssuer: string | undefined;
      try {
        expectedIssuer = opts.acceptNewIssuer ? undefined : readEnvFileValue(envFile, HUB_ISSUER_VAR);
      } catch { /* unreadable env file: the write below reports it */ }

      let accessToken: string;
      let issuer: string;
      try {
        const signedIn = await deviceSignIn(relayUrl, {
          kind: "hub",
          scope: HUB_REGISTER_SCOPE,
          ...(expectedIssuer ? { expectedIssuer } : {}),
          onCode: async (dc, openUrl) => {
            for (const line of deviceCodeLines("Share the following URL with an admin", dc, openUrl, "the admin")) console.log(line);
            console.log("Waiting for admin approval...\n");
            if (openUrl) {
              try { await open(openUrl); } catch { /* ignore */ }
            }
          },
        });
        accessToken = signedIn.tokens.access_token;
        issuer = signedIn.endpoints.issuer;
      } catch (err) {
        if (err instanceof AsterismError && err.code === "access_denied") {
          console.error("\nAccess denied. Ensure the approving user is in the admin group.");
        } else if (err instanceof AsterismError && err.code === "issuer_changed") {
          console.error(`\n${t(err.message)}\nPass --accept-new-issuer if you trust the change.`);
        } else {
          console.error(`\n${t((err as Error).message)}`);
        }
        process.exit(1);
      }

      const result = await registerExecutor(relayUrl, accessToken, { type: "hub", host: checkedHost.host });
      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }

      // Write the token to the env file. Never print the raw token value.
      if (!EXECUTOR_TOKEN_PATTERN.test(result.access_token)) {
        console.error("The relay returned a malformed token; nothing was written.");
        process.exit(1);
      }
      writeEnvToken(envFile, result.access_token);
      writeEnvFileValue(envFile, HUB_ISSUER_VAR, issuer);
      warnIfEnvFileInsecure(envFile);

      console.log(`Hub '${t(result.host)}' registered successfully.`);
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
          console.error(`Error: user_map entry for sub '${entry.sub}' maps to '${entry.local_username}' which does not exist on this system`);
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

      const disk = auditLogDiskStatus(cfg.audit_log);

      const out = {
        hub_name: cfg.hub_name,
        relay_url: cfg.relay_url,
        shares: cfg.shares.map((s) => ({ name: s.name, path: s.path, default_access: s.permissions.default })),
        audit_log: { path: cfg.audit_log, disk },
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
        console.log(`Audit log: ${out.audit_log.path}`);
        console.log(
          disk
            ? `  Disk (${disk.dir}): ${formatBytes(disk.free_bytes)} free / ${formatBytes(disk.total_bytes)} total`
            : `  Disk: unavailable (directory may not exist yet)`
        );
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
      let cfg;
      try {
        cfg = loadHubConfig(opts.configFile);
      } catch (err) {
        console.error(`Error loading config: ${(err as Error).message}`);
        process.exit(1);
      }

      const isPkg = (process as typeof process & { pkg?: unknown }).pkg !== undefined;
      const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
      const execLine = isPkg
        ? `${q(process.execPath)} hub start --config-file ${q(opts.configFile)}`
        : `${q(process.execPath)} ${q(process.argv[1]!)} hub start --config-file ${q(opts.configFile)}`;
      // The control channel's socket file lives next to the audit log (always present,
      // already covered below) — only a live-rotated token's persistence to env_file
      // needs a write grant of its own, and only when env_file is actually configured.
      const readWritePaths = ["/var/log/constellation", ...(cfg.env_file ? [dirname(cfg.env_file)] : [])].join(" ");
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
ReadWritePaths=${readWritePaths}

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

      // Prefer asking the running daemon to rotate on its own live connection — it
      // performs the full handshake itself, persists the new token to env_file, and
      // only reports success once it has actually reconnected with it: no restart,
      // no race. Opening a second WebSocket of our own here (the fallback below)
      // would otherwise evict the daemon's live connection outright, since the relay
      // allows only one per executor. Control file lives alongside the audit log —
      // see runHub()'s startControlServer call for why.
      const viaControl = await requestRotateViaControlChannel(dirname(cfg.audit_log));
      if (viaControl) {
        if (viaControl.ok) {
          console.log("Token rotated — the running hub has reconnected with the new token. No restart needed.");
        } else {
          console.error("Error:", t(viaControl.error));
          process.exit(1);
        }
        return;
      }

      // No daemon reachable — nothing to evict, but also nothing to confirm the
      // reconnect for. Rotate directly; the next `hub start` picks up the new token.

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

      let wsUrl: string;
      try {
        wsUrl = relayWsUrl(cfg.relay_url) + "/executor/connect";
      } catch (err) {
        console.error("Error:", t((err as Error).message));
        process.exit(1);
      }

      const newToken = await new Promise<string | null>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
        const timeout = setTimeout(() => { ws.terminate(); resolve(null); }, 15_000);

        ws.on("open", () => ws.send(JSON.stringify({ type: "rotate_token" })));
        ws.on("message", (data: Buffer) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(data.toString()) as Record<string, unknown>;
          } catch {
            console.error("Received non-JSON message from relay");
            return;
          }
          if (msg["type"] === "token_rotated" && typeof msg["token"] === "string") {
            clearTimeout(timeout);
            ws.close();
            if (!EXECUTOR_TOKEN_PATTERN.test(msg["token"])) {
              console.error("The relay sent a malformed token; the hub token was not changed.");
              resolve(null);
              return;
            }
            resolve(msg["token"]);
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timeout);
          console.error("Error:", t(err.message));
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

/** The env file also records which authorization server issued the hub token, so a later `hub register` can pin to it. */
const HUB_ISSUER_VAR = "CONSTELLATION_HUB_ISSUER";
/** Registering mints a long-lived credential: the relay requires `register` (a fresh sign-in) and, for a hub, `admin`. */
const HUB_REGISTER_SCOPE = "relay admin register";

function writeEnvToken(envFile: string, token: string): void {
  try {
    mkdirSync(dirname(envFile), { recursive: true });
  } catch {
    // Directory may already exist or be /etc (no write permission without sudo).
    // The write below surfaces the real error.
  }
  try {
    writeEnvFileValue(envFile, "CONSTELLATION_HUB_TOKEN", token);
  } catch (err) {
    console.error(`Could not write the hub token to ${envFile}: ${t((err as Error).message)}`);
    process.exit(1);
  }
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
