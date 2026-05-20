import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { run, runInherited, currentPlatform } from "./util.js";

const SERVICE_NAME = "constellation-agent";

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Registers the agent with the OS service manager for user-scoped autostart.
 * Does not require escalation.
 */
export function install(executablePath: string): void {
  const p = currentPlatform();

  if (p === "linux") {
    installSystemd(executablePath);
  } else if (p === "darwin") {
    installLaunchd(executablePath);
  } else if (p === "win32") {
    installTaskScheduler(executablePath);
  } else {
    throw new Error("Unsupported platform for service install");
  }
}

function installSystemd(_exec: string): void {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });

  // Use absolute paths for node and the CLI script so the unit never depends
  // on PATH being set in the systemd environment.
  const nodePath = process.execPath;
  const scriptPath = process.argv[1]!;

  const unitPath = join(unitDir, `${SERVICE_NAME}.service`);
  const unit = `[Unit]
Description=Constellation Agent
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} agent start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit);
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", SERVICE_NAME]);
  console.log(`Installed systemd user unit: ${unitPath}`);
}

function installLaunchd(_exec: string): void {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(plistDir, { recursive: true });

  const nodePath = process.execPath;
  const scriptPath = process.argv[1]!;

  const label = `com.constellation.agent`;
  const plistPath = join(plistDir, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>agent</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), "Library", "Logs", "constellation-agent.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), "Library", "Logs", "constellation-agent.log")}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist);
  console.log(`Installed launchd plist: ${plistPath}`);
  console.log(`Run 'constellation agent start' to load it.`);
}

function installTaskScheduler(_exec: string): void {
  const nodePath = process.execPath;
  const scriptPath = process.argv[1]!;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>${scriptPath} agent start --foreground</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
</Task>
`;
  const tmpPath = join(process.env["TEMP"] ?? "C:\\Temp", `${SERVICE_NAME}.xml`);
  writeFileSync(tmpPath, xml, "utf16le");
  run("schtasks", ["/Create", "/TN", SERVICE_NAME, "/XML", tmpPath, "/F"]);
  console.log(`Registered Task Scheduler task: ${SERVICE_NAME}`);
}

// ---------------------------------------------------------------------------
// Start / Stop / Restart
// ---------------------------------------------------------------------------

export function startService(): void {
  const p = currentPlatform();
  if (p === "linux") runInherited("systemctl", ["--user", "start", SERVICE_NAME]);
  else if (p === "darwin") runInherited("launchctl", ["load", launchAgentPlist()]);
  else if (p === "win32") runInherited("schtasks", ["/Run", "/TN", SERVICE_NAME]);
  else throw new Error("Unsupported platform");
}

export function stopService(): void {
  const p = currentPlatform();
  if (p === "linux") runInherited("systemctl", ["--user", "stop", SERVICE_NAME]);
  else if (p === "darwin") runInherited("launchctl", ["unload", launchAgentPlist()]);
  else if (p === "win32") runInherited("schtasks", ["/End", "/TN", SERVICE_NAME]);
  else throw new Error("Unsupported platform");
}

export function restartService(): void {
  const p = currentPlatform();
  if (p === "linux") runInherited("systemctl", ["--user", "restart", SERVICE_NAME]);
  else if (p === "darwin") {
    runInherited("launchctl", ["unload", launchAgentPlist()]);
    runInherited("launchctl", ["load", launchAgentPlist()]);
  } else if (p === "win32") {
    runInherited("schtasks", ["/End", "/TN", SERVICE_NAME]);
    runInherited("schtasks", ["/Run", "/TN", SERVICE_NAME]);
  } else {
    throw new Error("Unsupported platform");
  }
}

export function serviceStatus(): string {
  const p = currentPlatform();
  try {
    if (p === "linux") return run("systemctl", ["--user", "is-active", SERVICE_NAME]);
    if (p === "darwin") {
      const out = run("launchctl", ["list", "com.constellation.agent"]);
      return out.includes('"PID"') ? "active" : "inactive";
    }
    if (p === "win32") {
      const out = run("schtasks", ["/Query", "/TN", SERVICE_NAME, "/FO", "LIST"]);
      return out.includes("Running") ? "active" : "inactive";
    }
  } catch {
    return "inactive";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function showLogs(follow: boolean, lines: number): void {
  const p = currentPlatform();
  if (p === "linux") {
    const args = ["--user", "-u", SERVICE_NAME, "-n", String(lines)];
    if (follow) args.push("-f");
    runInherited("journalctl", args);
  } else if (p === "darwin") {
    const logPath = join(homedir(), "Library", "Logs", "constellation-agent.log");
    if (follow) runInherited("tail", ["-f", "-n", String(lines), logPath]);
    else runInherited("tail", ["-n", String(lines), logPath]);
  } else if (p === "win32") {
    console.error("Log tailing is not supported on Windows — check Event Viewer for Task Scheduler logs.");
    process.exit(1);
  } else {
    throw new Error("Unsupported platform");
  }
}

function launchAgentPlist(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.constellation.agent.plist");
}
