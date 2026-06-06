import { readFileSync } from "node:fs";
import yaml from "js-yaml";

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
  permissions: {
    default: AccessLevel;
    overrides: LabelOverride[];
  };
}

export interface UidRange {
  min?: number;
  max?: number;
}

export interface SubagentUidConfig {
  allowed_range?: UidRange;
  blocked_range?: UidRange;
  blocked_uids?: number[];
}

export interface IdentityConfig {
  claims: string[];
  user_map: Array<{ oidc_sub: string; local_username: string }>;
  allow_preferred_username: boolean;
}

export interface SharedAgentConfig {
  broker_url: string;
  agent_name: string;
  env_file?: string;
  subagent_idle_timeout_seconds: number;
  subagent_rpc_timeout_seconds: number;
  subagent_uid: SubagentUidConfig;
  labels: LabelConfig[];
  identity: IdentityConfig;
  audit_log: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadSharedConfig(path: string): SharedAgentConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const broker_url = str(parsed, "broker_url");
  const agent_name = str(parsed, "agent_name");
  const audit_log = str(parsed, "audit_log");

  if (!broker_url) throw new Error("shared agent config: broker_url is required");
  if (!agent_name) throw new Error("shared agent config: agent_name is required");
  if (!audit_log) throw new Error("shared agent config: audit_log is required");

  const env_file = str(parsed, "env_file") || undefined;
  const subagent_idle_timeout_seconds = num(parsed, "subagent_idle_timeout_seconds") ?? 300;
  const subagent_rpc_timeout_seconds = num(parsed, "subagent_rpc_timeout_seconds") ?? 30;

  const labels = parseLabels(parsed);
  const subagent_uid = parseSubagentUid((parsed["subagent_uid"] ?? {}) as Record<string, unknown>);
  const identity = parseIdentity((parsed["identity"] ?? {}) as Record<string, unknown>);

  return {
    broker_url,
    agent_name,
    env_file,
    subagent_idle_timeout_seconds,
    subagent_rpc_timeout_seconds,
    subagent_uid,
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

export function validateSharedConfig(cfg: SharedAgentConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (cfg.subagent_rpc_timeout_seconds <= 0) {
    errors.push("subagent_rpc_timeout_seconds must be a positive integer");
  }

  const { allowed_range, blocked_range } = cfg.subagent_uid;
  if (allowed_range?.min !== undefined && allowed_range?.max !== undefined
    && allowed_range.min > allowed_range.max) {
    errors.push("subagent_uid.allowed_range.min must be <= max");
  }
  if (blocked_range?.min !== undefined && blocked_range?.max !== undefined
    && blocked_range.min > blocked_range.max) {
    errors.push("subagent_uid.blocked_range.min must be <= max");
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
  if (!Array.isArray(rawLabels)) throw new Error("shared agent config: labels must be an array");

  return rawLabels.map((l: unknown, i: number) => {
    const le = l as Record<string, unknown>;
    const name = str(le, "name");
    const path = str(le, "path");
    const perms = le["permissions"] as Record<string, unknown> | undefined;

    if (!name) throw new Error(`shared agent config: labels[${i}].name is required`);
    if (!path) throw new Error(`shared agent config: labels[${i}].path is required`);
    if (!perms) throw new Error(`shared agent config: labels[${i}].permissions is required`);

    const defaultAccess = str(perms, "default") as AccessLevel;
    if (!["read-only", "read-write", "none"].includes(defaultAccess)) {
      throw new Error(
        `shared agent config: labels[${i}].permissions.default must be read-only, read-write, or none`
      );
    }

    const overrides: LabelOverride[] = [];
    if (Array.isArray(perms["overrides"])) {
      for (let j = 0; j < perms["overrides"].length; j++) {
        const ov = perms["overrides"][j] as Record<string, unknown>;
        const oidc_sub = str(ov, "oidc_sub");
        const access = str(ov, "access") as AccessLevel;
        if (!oidc_sub) {
          throw new Error(`shared agent config: labels[${i}].permissions.overrides[${j}] missing oidc_sub`);
        }
        if (!["read-only", "read-write", "none"].includes(access)) {
          throw new Error(
            `shared agent config: labels[${i}].permissions.overrides[${j}] has invalid access level`
          );
        }
        overrides.push({ oidc_sub, access });
      }
    }

    return { name, path, permissions: { default: defaultAccess, overrides } };
  });
}

function parseSubagentUid(raw: Record<string, unknown>): SubagentUidConfig {
  const cfg: SubagentUidConfig = {};

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
// Helpers
// ---------------------------------------------------------------------------

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}
