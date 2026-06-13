import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import yaml from "js-yaml";
import { createLogger, MAX_LABEL_INSTRUCTIONS_LENGTH, type PathEntry } from "@constellation/shared";

const log = createLogger("node:config");

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

export function nodeYamlPath(dir: string): string { return join(dir, "node.yaml"); }
export function pathsYamlPath(dir: string): string { return join(dir, "paths.yaml"); }

// ---------------------------------------------------------------------------
// node.yaml
// ---------------------------------------------------------------------------

export interface NodeConfig {
  relay_url: string;
  node_token: string;
  host: string;
  max_file_size_kb: number;
}

export function loadNodeConfig(dir: string): NodeConfig {
  const raw = readFileSync(nodeYamlPath(dir), "utf8");
  const parsed = yaml.load(raw) as Partial<NodeConfig>;

  const relay_url = str(parsed, "relay_url");
  const node_token = str(parsed, "node_token");
  const host = str(parsed, "host");
  const max_file_size_kb = typeof parsed["max_file_size_kb"] === "number"
    ? parsed["max_file_size_kb"]
    : 100;

  if (!relay_url) throw new Error("node.yaml: relay_url is required");
  if (!node_token) throw new Error("node.yaml: node_token is required");
  if (!host) throw new Error("node.yaml: host is required");

  return { relay_url, node_token, host, max_file_size_kb };
}

export function writeNodeToken(dir: string, token: string): void {
  const path = nodeYamlPath(dir);
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as Partial<NodeConfig>;
  parsed.node_token = token;
  writeFileSync(path, yaml.dump(parsed), { mode: 0o600 });
}

export function writeNodeConfig(dir: string, config: Partial<NodeConfig>): void {
  const path = nodeYamlPath(dir);
  let parsed: Partial<NodeConfig> = {};
  try {
    parsed = yaml.load(readFileSync(path, "utf8")) as Partial<NodeConfig>;
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
// relay-session.yaml
// ---------------------------------------------------------------------------

export interface RelaySession {
  relay_url: string;
  access_token: string;
  access_token_expires_at: string; // ISO 8601
  refresh_token?: string;
  refresh_token_expires_at?: string; // ISO 8601
}

export function relaySessionPath(dir: string): string {
  return join(dir, "relay-session.yaml");
}

export function loadRelaySession(dir: string): RelaySession {
  const raw = readFileSync(relaySessionPath(dir), "utf8");
  const parsed = yaml.load(raw) as Partial<RelaySession>;
  const relay_url = parsed.relay_url ?? "";
  const access_token = parsed.access_token ?? "";
  const access_token_expires_at = parsed.access_token_expires_at ?? "";
  if (!relay_url || !access_token || !access_token_expires_at) {
    throw new Error("relay-session.yaml is incomplete — run 'constellation relay login' first");
  }
  return {
    relay_url,
    access_token,
    access_token_expires_at,
    refresh_token: parsed.refresh_token || undefined,
    refresh_token_expires_at: parsed.refresh_token_expires_at || undefined,
  };
}

export function writeRelaySession(dir: string, session: RelaySession): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(relaySessionPath(dir), yaml.dump(session), { mode: 0o600 });
}

export function deleteRelaySession(dir: string): void {
  try {
    unlinkSync(relaySessionPath(dir));
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
