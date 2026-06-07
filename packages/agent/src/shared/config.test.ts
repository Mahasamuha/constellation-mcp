import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanTempDir } from "../test/fixtures.js";
import { loadSharedConfig, validateSharedConfig, type SharedAgentConfig } from "./config.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(dir);
});

const BASE_YAML = `
broker_url: https://broker.example.com
agent_name: test-agent
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
    permissions:
      default: read-only
`;

async function writeConfig(yaml: string): Promise<string> {
  const path = join(dir, "shared-agent.yaml");
  await fs.writeFile(path, yaml, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// loadSharedConfig
// ---------------------------------------------------------------------------

describe("loadSharedConfig", () => {
  it("loads a minimal valid config and applies defaults", async () => {
    const path = await writeConfig(BASE_YAML);
    const cfg = loadSharedConfig(path);

    expect(cfg.broker_url).toBe("https://broker.example.com");
    expect(cfg.agent_name).toBe("test-agent");
    expect(cfg.subagent_idle_timeout_seconds).toBe(300);
    expect(cfg.subagent_rpc_timeout_seconds).toBe(30);
    expect(cfg.labels).toHaveLength(1);
    expect(cfg.labels[0]).toMatchObject({ name: "docs", path: "/srv/docs", permissions: { default: "read-only", overrides: [] } });
    expect(cfg.identity).toEqual({ claims: [], user_map: [], allow_preferred_username: false });
  });

  it.each(["broker_url", "agent_name", "audit_log"])("rejects a config missing required field '%s'", async (field) => {
    const lines = BASE_YAML.split("\n").filter((l) => !l.startsWith(`${field}:`));
    const path = await writeConfig(lines.join("\n"));

    expect(() => loadSharedConfig(path)).toThrow(new RegExp(`${field} is required`));
  });

  it("rejects labels without a permissions block", async () => {
    const path = await writeConfig(`
broker_url: https://broker.example.com
agent_name: test-agent
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
`);

    expect(() => loadSharedConfig(path)).toThrow(/permissions is required/);
  });

  it("rejects an invalid default access level", async () => {
    const path = await writeConfig(`
broker_url: https://broker.example.com
agent_name: test-agent
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
    permissions:
      default: super-admin
`);

    expect(() => loadSharedConfig(path)).toThrow(/permissions\.default must be read-only, read-write, or none/);
  });

  it("parses overrides and identity config", async () => {
    const path = await writeConfig(`
broker_url: https://broker.example.com
agent_name: test-agent
audit_log: /var/log/constellation/audit.jsonl
subagent_idle_timeout_seconds: 60
subagent_rpc_timeout_seconds: 15
labels:
  - name: docs
    path: /srv/docs
    permissions:
      default: read-only
      overrides:
        - oidc_sub: user-1
          access: read-write
identity:
  claims: [uid, sAMAccountName]
  user_map:
    - oidc_sub: sub-1
      local_username: alice
  allow_preferred_username: true
`);
    const cfg = loadSharedConfig(path);

    expect(cfg.subagent_idle_timeout_seconds).toBe(60);
    expect(cfg.subagent_rpc_timeout_seconds).toBe(15);
    expect(cfg.labels[0]!.permissions.overrides).toEqual([{ oidc_sub: "user-1", access: "read-write" }]);
    expect(cfg.identity).toEqual({
      claims: ["uid", "sAMAccountName"],
      user_map: [{ oidc_sub: "sub-1", local_username: "alice" }],
      allow_preferred_username: true,
    });
  });
});

// ---------------------------------------------------------------------------
// validateSharedConfig
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<SharedAgentConfig> = {}): SharedAgentConfig {
  return {
    broker_url: "https://broker.example.com",
    agent_name: "test-agent",
    subagent_idle_timeout_seconds: 300,
    subagent_rpc_timeout_seconds: 30,
    subagent_uid: {},
    subagent_gid: {},
    labels: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
    ...overrides,
  };
}

describe("validateSharedConfig", () => {
  it("passes a well-formed config with no warnings", () => {
    const result = validateSharedConfig(baseConfig());
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("rejects a non-positive subagent_rpc_timeout_seconds", () => {
    const result = validateSharedConfig(baseConfig({ subagent_rpc_timeout_seconds: 0 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subagent_rpc_timeout_seconds must be a positive integer");
  });

  it("rejects an inverted allowed_range", () => {
    const result = validateSharedConfig(baseConfig({ subagent_uid: { allowed_range: { min: 5000, max: 1000 } } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subagent_uid.allowed_range.min must be <= max");
  });

  it("rejects an inverted blocked_range", () => {
    const result = validateSharedConfig(baseConfig({ subagent_uid: { blocked_range: { min: 5000, max: 1000 } } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subagent_uid.blocked_range.min must be <= max");
  });

  it("warns when allow_preferred_username is enabled", () => {
    const result = validateSharedConfig(baseConfig({
      identity: { claims: [], user_map: [], allow_preferred_username: true },
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining("identity.allow_preferred_username is true"),
    ]);
  });

  it("rejects duplicate label names", () => {
    const label = { name: "docs", path: "/srv/docs", permissions: { default: "read-only" as const, overrides: [] } };
    const result = validateSharedConfig(baseConfig({ labels: [label, { ...label, path: "/srv/docs2" }] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Duplicate label name: docs");
  });
});
