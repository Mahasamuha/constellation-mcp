import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import yaml from "js-yaml";
import { createLogger, MAX_LABEL_INSTRUCTIONS_LENGTH, type PathEntry } from "@constellation/shared";

const log = createLogger("agent:config");

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
  const parsed = yaml.load(raw) as Partial<AgentConfig>;

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
  const parsed = yaml.load(raw) as Partial<AgentConfig>;
  parsed.agent_token = token;
  writeFileSync(path, yaml.dump(parsed), { mode: 0o600 });
}

export function writeAgentConfig(dir: string, config: Partial<AgentConfig>): void {
  const path = agentYamlPath(dir);
  let parsed: Partial<AgentConfig> = {};
  try {
    parsed = yaml.load(readFileSync(path, "utf8")) as Partial<AgentConfig>;
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

export interface PathsConfig {
  paths: PathEntry[];
}

export function loadPathsConfig(dir: string): PathsConfig {
  try {
    const raw = readFileSync(pathsYamlPath(dir), "utf8");
    const parsed = yaml.load(raw) as { paths?: object[] };
    const paths = (parsed?.paths ?? []).map((p) => {
      const entry: PathEntry = { label: str(p, "label") ?? "", path: str(p, "path") ?? "" };
      const contextFile = str(p, "context_file");
      if (contextFile) entry.context_file = contextFile;
      const instructions = str(p, "instructions");
      if (instructions) entry.instructions = instructions;
      return entry;
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

/**
 * Maps configured paths to the config_update payload shape, resolving each
 * entry's `instructions`: an inline `instructions` string takes precedence
 * over `context_file`, which is read at sync time. A missing/unreadable
 * context_file is logged at info level and the field is silently omitted —
 * not an error. Either source exceeding MAX_LABEL_INSTRUCTIONS_LENGTH is
 * logged as a warning and dropped.
 */
export function buildConfigUpdatePaths(
  paths: PathEntry[]
): Array<{ label: string; reported_path: string; instructions?: string }> {
  return paths.map((p) => {
    const entry: { label: string; reported_path: string; instructions?: string } = {
      label: p.label,
      reported_path: p.path,
    };

    let instructions: string | undefined;
    if (p.instructions) {
      instructions = p.instructions;
    } else if (p.context_file) {
      try {
        instructions = readFileSync(p.context_file, "utf8");
      } catch {
        log.info({ label: p.label, context_file: p.context_file }, "context_file is set but could not be read — omitting instructions");
      }
    }

    if (instructions !== undefined) {
      if (instructions.length > MAX_LABEL_INSTRUCTIONS_LENGTH) {
        log.warn(
          { label: p.label, length: instructions.length, max: MAX_LABEL_INSTRUCTIONS_LENGTH },
          "instructions exceeds maximum length — dropping"
        );
      } else {
        entry.instructions = instructions;
      }
    }

    return entry;
  });
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
  const parsed = yaml.load(raw) as Partial<BrokerSession>;
  const broker_url = parsed.broker_url ?? "";
  const access_token = parsed.access_token ?? "";
  const access_token_expires_at = parsed.access_token_expires_at ?? "";
  if (!broker_url || !access_token || !access_token_expires_at) {
    throw new Error("broker-session.yaml is incomplete — run 'constellation broker login' first");
  }
  return {
    broker_url,
    access_token,
    access_token_expires_at,
    refresh_token: parsed.refresh_token || undefined,
    refresh_token_expires_at: parsed.refresh_token_expires_at || undefined,
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

function str(obj: object, key: string): string {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}
