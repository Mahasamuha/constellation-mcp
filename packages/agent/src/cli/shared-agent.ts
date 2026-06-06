import { Command } from "commander";
import { hostname } from "node:os";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import open from "open";
import { poll } from "./util.js";

// ---------------------------------------------------------------------------
// Register all shared-agent commands
// ---------------------------------------------------------------------------

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
    .requiredOption("--config <path>", "Path to shared agent config file")
    .action(async (opts: { config: string }) => {
      // Phase 3 implementation: validate the YAML config (label paths, uid ranges, etc.)
      console.error("validate-config is not yet implemented (requires Phase 3).");
      process.exit(1);
    });

  // -------------------------------------------------------------------------
  // start / stop / status / rotate-token stubs (Phase 3)
  // -------------------------------------------------------------------------

  sharedAgent
    .command("start")
    .description("Start the shared agent service [Phase 3]")
    .option("--config <path>", "Path to shared agent config file")
    .action(async () => {
      console.error("shared-agent start is not yet implemented (requires Phase 3).");
      process.exit(1);
    });

  sharedAgent
    .command("stop")
    .description("Stop the shared agent service [Phase 3]")
    .action(async () => {
      console.error("shared-agent stop is not yet implemented (requires Phase 3).");
      process.exit(1);
    });

  sharedAgent
    .command("status")
    .description("Show shared agent status [Phase 3]")
    .action(async () => {
      console.error("shared-agent status is not yet implemented (requires Phase 3).");
      process.exit(1);
    });

  sharedAgent
    .command("rotate-token")
    .description("Rotate the shared agent token [Phase 3]")
    .action(async () => {
      console.error("shared-agent rotate-token is not yet implemented (requires Phase 3).");
      process.exit(1);
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
