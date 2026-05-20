import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function configDir(override?: string): string {
  if (override) return override;
  if (platform() === "win32") {
    const appdata = process.env["APPDATA"];
    if (!appdata) throw new Error("APPDATA not set");
    return join(appdata, "constellation");
  }
  return join(homedir(), ".config", "constellation");
}

export function agentYamlPath(dir: string): string { return join(dir, "agent.yaml"); }
export function pathsYamlPath(dir: string): string { return join(dir, "paths.yaml"); }

// ---------------------------------------------------------------------------
// agent.yaml
// ---------------------------------------------------------------------------

export interface AgentConfig {
  broker_url: string;
  agent_token: string;
  host: string;
  max_file_size_kb: number;
}

export function loadAgentConfig(dir: string): AgentConfig {
  const raw = readFileSync(agentYamlPath(dir), "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const broker_url = str(parsed, "broker_url");
  const agent_token = str(parsed, "agent_token");
  const host = str(parsed, "host");
  const max_file_size_kb = typeof parsed["max_file_size_kb"] === "number"
    ? parsed["max_file_size_kb"]
    : 100;

  if (!broker_url) throw new Error("agent.yaml: broker_url is required");
  if (!agent_token) throw new Error("agent.yaml: agent_token is required");
  if (!host) throw new Error("agent.yaml: host is required");

  return { broker_url, agent_token, host, max_file_size_kb };
}

export function writeAgentToken(dir: string, token: string): void {
  const path = agentYamlPath(dir);
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  parsed["agent_token"] = token;
  writeFileSync(path, yaml.dump(parsed), { mode: 0o600 });
}

export function writeAgentConfig(dir: string, config: Partial<AgentConfig>): void {
  const path = agentYamlPath(dir);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = yaml.load(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // file may not exist yet during init
  }
  Object.assign(parsed, config);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, yaml.dump(parsed), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// paths.yaml
// ---------------------------------------------------------------------------

export interface PathEntry {
  label: string;
  path: string;
}

export interface PathsConfig {
  paths: PathEntry[];
}

export function loadPathsConfig(dir: string): PathsConfig {
  try {
    const raw = readFileSync(pathsYamlPath(dir), "utf8");
    const parsed = yaml.load(raw) as { paths?: unknown[] };
    const paths = (parsed?.paths ?? []).map((p) => {
      const entry = p as Record<string, unknown>;
      return { label: str(entry, "label") ?? "", path: str(entry, "path") ?? "" };
    }).filter((e) => e.label && e.path);
    return { paths };
  } catch {
    return { paths: [] };
  }
}

export function writePathsConfig(dir: string, config: PathsConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathsYamlPath(dir), yaml.dump(config), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// broker-session.yaml
// ---------------------------------------------------------------------------

export interface BrokerSession {
  broker_url: string;
  access_token: string;
  access_token_expires_at: string; // ISO 8601
  refresh_token?: string;
  refresh_token_expires_at?: string; // ISO 8601
}

export function brokerSessionPath(dir: string): string {
  return join(dir, "broker-session.yaml");
}

export function loadBrokerSession(dir: string): BrokerSession {
  const raw = readFileSync(brokerSessionPath(dir), "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  const broker_url = str(parsed, "broker_url");
  const access_token = str(parsed, "access_token");
  const access_token_expires_at = str(parsed, "access_token_expires_at");
  if (!broker_url || !access_token || !access_token_expires_at) {
    throw new Error("broker-session.yaml is incomplete — run 'constellation broker login' first");
  }
  return {
    broker_url,
    access_token,
    access_token_expires_at,
    refresh_token: str(parsed, "refresh_token") || undefined,
    refresh_token_expires_at: str(parsed, "refresh_token_expires_at") || undefined,
  };
}

export function writeBrokerSession(dir: string, session: BrokerSession): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(brokerSessionPath(dir), yaml.dump(session), { mode: 0o600 });
}

export function deleteBrokerSession(dir: string): void {
  try {
    unlinkSync(brokerSessionPath(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}
