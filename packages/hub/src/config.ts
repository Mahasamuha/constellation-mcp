import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { resolveQueueTimeout, str, num } from "@constellation/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessLevel = "read-only" | "read-write" | "none";

export interface LabelOverride {
  oidc_sub: string;
  access: AccessLevel;
}

export interface LabelConfig {
  name: string;
  path: string;
  instructions?: string;
  context_file?: string;
  permissions: {
    default: AccessLevel;
    overrides: LabelOverride[];
  };
}

export interface UidRange {
  min?: number;
  max?: number;
}

export interface SubnodeUidConfig {
  allowed_range?: UidRange;
  blocked_range?: UidRange;
  blocked_uids?: number[];
}

export interface SubnodeGidConfig {
  blocked_gids?: number[];
}

export interface SubnodeWorkersConfig {
  min: number;
  max: number;
  warm_idle_seconds: number;
  burst_idle_seconds: number;
  queue_timeout: number;
}

/** Hard floor on worker idle timeouts (seconds). */
export const MIN_WORKER_IDLE_SECONDS = 30;

export interface IdentityConfig {
  claims: string[];
  user_map: Array<{ oidc_sub: string; local_username: string }>;
  allow_preferred_username: boolean;
}

export interface HubConfig {
  relay_url: string;
  hub_name: string;
  env_file?: string;
  subnode_workers: SubnodeWorkersConfig;
  subnode_rpc_timeout_seconds: number;
  subnode_uid: SubnodeUidConfig;
  subnode_gid: SubnodeGidConfig;
  labels: LabelConfig[];
  identity: IdentityConfig;
  audit_log: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadHubConfig(path: string): HubConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const relay_url = str(parsed, "relay_url");
  const hub_name = str(parsed, "hub_name");
  const audit_log = str(parsed, "audit_log");

  if (!relay_url) throw new Error("hub config: relay_url is required");
  if (!hub_name) throw new Error("hub config: hub_name is required");
  if (!audit_log) throw new Error("hub config: audit_log is required");

  const env_file = str(parsed, "env_file") || undefined;
  const subnode_rpc_timeout_seconds = num(parsed, "subnode_rpc_timeout_seconds") ?? 30;

  const labels = parseLabels(parsed);
  const subnode_uid = parseSubnodeUid((parsed["subnode_uid"] ?? {}) as Record<string, unknown>);
  const subnode_gid = parseSubnodeGid((parsed["subnode_gid"] ?? {}) as Record<string, unknown>);
  const subnode_workers = parseSubnodeWorkers((parsed["subnode_workers"] ?? {}) as Record<string, unknown>);
  const identity = parseIdentity((parsed["identity"] ?? {}) as Record<string, unknown>);

  return {
    relay_url,
    hub_name,
    env_file,
    subnode_workers,
    subnode_rpc_timeout_seconds,
    subnode_uid,
    subnode_gid,
    labels,
    identity,
    audit_log,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateHubConfig(cfg: HubConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cfg.subnode_rpc_timeout_seconds <= 0) {
    errors.push("subnode_rpc_timeout_seconds must be a positive integer");
  }

  const w = cfg.subnode_workers;
  if (w.min < 1) {
    errors.push("subnode_workers.min must be >= 1");
  }
  if (w.max < w.min) {
    errors.push("subnode_workers.max must be >= subnode_workers.min");
  }
  if (w.warm_idle_seconds < MIN_WORKER_IDLE_SECONDS) {
    errors.push(`subnode_workers.warm_idle_seconds must be >= ${MIN_WORKER_IDLE_SECONDS}`);
  }
  if (w.burst_idle_seconds < MIN_WORKER_IDLE_SECONDS) {
    errors.push(`subnode_workers.burst_idle_seconds must be >= ${MIN_WORKER_IDLE_SECONDS}`);
  }
  if (w.queue_timeout <= 0) {
    errors.push("subnode_workers.queue_timeout must be > 0");
  } else if (!Number.isInteger(w.queue_timeout) && (w.queue_timeout < 0.3 || w.queue_timeout > 0.8)) {
    // queue_timeout is only a fraction of subnode_rpc_timeout_seconds when non-integer
    // (see resolveQueueTimeout). Outside [0.3, 0.8] it tends to misbehave either way:
    // below 0.3, queued requests time out before a worker is likely to free up; above
    // 0.8, a request that does get a worker has too little of the RPC budget left to
    // finish before subnode_rpc_timeout_seconds elapses.
    warnings.push(
      `subnode_workers.queue_timeout (${w.queue_timeout}) is a fraction of subnode_rpc_timeout_seconds outside the recommended [0.3, 0.8] range — values below 0.3 may time out requests before a worker frees up, and values above 0.8 leave little RPC budget for processing after the wait.`
    );
  }

  const { allowed_range, blocked_range } = cfg.subnode_uid;
  if (allowed_range?.min !== undefined && allowed_range?.max !== undefined
    && allowed_range.min > allowed_range.max) {
    errors.push("subnode_uid.allowed_range.min must be <= max");
  }
  if (blocked_range?.min !== undefined && blocked_range?.max !== undefined
    && blocked_range.min > blocked_range.max) {
    errors.push("subnode_uid.blocked_range.min must be <= max");
  }

  if (cfg.identity.allow_preferred_username) {
    warnings.push(
      "identity.allow_preferred_username is true. preferred_username is editable by users on many OIDC providers and can be used for lateral movement. Enable only if your provider locks this claim."
    );
  }

  const labelNames = new Set<string>();
  for (const label of cfg.labels) {
    if (labelNames.has(label.name)) {
      errors.push(`Duplicate label name: ${label.name}`);
    }
    labelNames.add(label.name);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseLabels(parsed: Record<string, unknown>): LabelConfig[] {
  const rawLabels = parsed["labels"];
  if (!Array.isArray(rawLabels)) throw new Error("hub config: labels must be an array");

  return rawLabels.map((l: unknown, i: number) => {
    const le = l as Record<string, unknown>;
    const name = str(le, "name");
    const path = str(le, "path");
    const instructions = str(le, "instructions");
    const contextFile = str(le, "context_file");
    const perms = le["permissions"] as Record<string, unknown> | undefined;

    if (!name) throw new Error(`hub config: labels[${i}].name is required`);
    if (!path) throw new Error(`hub config: labels[${i}].path is required`);
    if (!perms) throw new Error(`hub config: labels[${i}].permissions is required`);

    const defaultAccess = str(perms, "default") as AccessLevel;
    if (!["read-only", "read-write", "none"].includes(defaultAccess)) {
      throw new Error(
        `hub config: labels[${i}].permissions.default must be read-only, read-write, or none`
      );
    }

    const overrides: LabelOverride[] = [];
    if (Array.isArray(perms["overrides"])) {
      for (let j = 0; j < perms["overrides"].length; j++) {
        const ov = perms["overrides"][j] as Record<string, unknown>;
        const oidc_sub = str(ov, "oidc_sub");
        const access = str(ov, "access") as AccessLevel;
        if (!oidc_sub) {
          throw new Error(`hub config: labels[${i}].permissions.overrides[${j}] missing oidc_sub`);
        }
        if (!["read-only", "read-write", "none"].includes(access)) {
          throw new Error(
            `hub config: labels[${i}].permissions.overrides[${j}] has invalid access level`
          );
        }
        overrides.push({ oidc_sub, access });
      }
    }

    const label: LabelConfig = { name, path, permissions: { default: defaultAccess, overrides } };
    if (instructions) label.instructions = instructions;
    if (contextFile) label.context_file = contextFile;
    return label;
  });
}

function parseSubnodeUid(raw: Record<string, unknown>): SubnodeUidConfig {
  const cfg: SubnodeUidConfig = {};

  if (raw["allowed_range"]) {
    const ar = raw["allowed_range"] as Record<string, unknown>;
    cfg.allowed_range = {};
    if (typeof ar["min"] === "number") cfg.allowed_range.min = ar["min"];
    if (typeof ar["max"] === "number") cfg.allowed_range.max = ar["max"];
  }

  if (raw["blocked_range"]) {
    const br = raw["blocked_range"] as Record<string, unknown>;
    cfg.blocked_range = {};
    if (typeof br["min"] === "number") cfg.blocked_range.min = br["min"];
    if (typeof br["max"] === "number") cfg.blocked_range.max = br["max"];
  }

  if (Array.isArray(raw["blocked_uids"])) {
    cfg.blocked_uids = (raw["blocked_uids"] as unknown[]).filter((v): v is number => typeof v === "number");
  }

  return cfg;
}

function parseSubnodeWorkers(raw: Record<string, unknown>): SubnodeWorkersConfig {
  const min = typeof raw["min"] === "number" ? raw["min"] : 1;
  const max = typeof raw["max"] === "number" ? raw["max"] : min;
  const warm_idle_seconds = typeof raw["warm_idle_seconds"] === "number" ? raw["warm_idle_seconds"] : 300;
  const burst_idle_seconds = typeof raw["burst_idle_seconds"] === "number" ? raw["burst_idle_seconds"] : 30;
  const queue_timeout = typeof raw["queue_timeout"] === "number" ? raw["queue_timeout"] : 0.5;
  return { min, max, warm_idle_seconds, burst_idle_seconds, queue_timeout };
}

function parseSubnodeGid(raw: Record<string, unknown>): SubnodeGidConfig {
  const cfg: SubnodeGidConfig = {};

  if (Array.isArray(raw["blocked_gids"])) {
    cfg.blocked_gids = (raw["blocked_gids"] as unknown[]).filter((v): v is number => typeof v === "number");
  }

  return cfg;
}

function parseIdentity(raw: Record<string, unknown>): IdentityConfig {
  const claims = Array.isArray(raw["claims"])
    ? (raw["claims"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  const user_map = Array.isArray(raw["user_map"])
    ? (raw["user_map"] as unknown[]).filter((e) => {
        const em = e as Record<string, unknown>;
        return typeof em["oidc_sub"] === "string" && typeof em["local_username"] === "string";
      }).map((e) => {
        const em = e as Record<string, unknown>;
        return { oidc_sub: em["oidc_sub"] as string, local_username: em["local_username"] as string };
      })
    : [];

  const allow_preferred_username = typeof raw["allow_preferred_username"] === "boolean"
    ? raw["allow_preferred_username"]
    : false;

  return { claims, user_map, allow_preferred_username };
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Resolves the queue_timeout config value to milliseconds. See @constellation/shared resolveQueueTimeout. */
export function resolveQueueTimeoutMs(cfg: HubConfig): number {
  return resolveQueueTimeout(cfg.subnode_workers.queue_timeout, cfg.subnode_rpc_timeout_seconds * 1000);
}
