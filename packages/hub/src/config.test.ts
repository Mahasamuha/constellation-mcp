import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";
import { loadHubConfig, validateHubConfig, type HubConfig } from "./config.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanTempDir(dir);
});

const BASE_YAML = `
relay_url: https://relay.example.com
hub_name: test-hub
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
    permissions:
      default: read-only
`;

async function writeConfig(yaml: string): Promise<string> {
  const path = join(dir, "hub.yaml");
  await fs.writeFile(path, yaml, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// loadHubConfig
// ---------------------------------------------------------------------------

describe("loadHubConfig", () => {
  it("loads a minimal valid config and applies defaults", async () => {
    const path = await writeConfig(BASE_YAML);
    const cfg = loadHubConfig(path);

    expect(cfg.relay_url).toBe("https://relay.example.com");
    expect(cfg.hub_name).toBe("test-hub");
    expect(cfg.subnode_idle_timeout_seconds).toBe(300);
    expect(cfg.subnode_rpc_timeout_seconds).toBe(30);
    expect(cfg.labels).toHaveLength(1);
    expect(cfg.labels[0]).toMatchObject({ name: "docs", path: "/srv/docs", permissions: { default: "read-only", overrides: [] } });
    expect(cfg.identity).toEqual({ claims: [], user_map: [], allow_preferred_username: false });
  });

  it.each(["relay_url", "hub_name", "audit_log"])("rejects a config missing required field '%s'", async (field) => {
    const lines = BASE_YAML.split("\n").filter((l) => !l.startsWith(`${field}:`));
    const path = await writeConfig(lines.join("\n"));

    expect(() => loadHubConfig(path)).toThrow(new RegExp(`${field} is required`));
  });

  it("rejects labels without a permissions block", async () => {
    const path = await writeConfig(`
relay_url: https://relay.example.com
hub_name: test-hub
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
`);

    expect(() => loadHubConfig(path)).toThrow(/permissions is required/);
  });

  it("rejects an invalid default access level", async () => {
    const path = await writeConfig(`
relay_url: https://relay.example.com
hub_name: test-hub
audit_log: /var/log/constellation/audit.jsonl
labels:
  - name: docs
    path: /srv/docs
    permissions:
      default: super-admin
`);

    expect(() => loadHubConfig(path)).toThrow(/permissions\.default must be read-only, read-write, or none/);
  });

  it("parses overrides and identity config", async () => {
    const path = await writeConfig(`
relay_url: https://relay.example.com
hub_name: test-hub
audit_log: /var/log/constellation/audit.jsonl
subnode_idle_timeout_seconds: 60
subnode_rpc_timeout_seconds: 15
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
    const cfg = loadHubConfig(path);

    expect(cfg.subnode_idle_timeout_seconds).toBe(60);
    expect(cfg.subnode_rpc_timeout_seconds).toBe(15);
    expect(cfg.labels[0]!.permissions.overrides).toEqual([{ oidc_sub: "user-1", access: "read-write" }]);
    expect(cfg.identity).toEqual({
      claims: ["uid", "sAMAccountName"],
      user_map: [{ oidc_sub: "sub-1", local_username: "alice" }],
      allow_preferred_username: true,
    });
  });
});

// ---------------------------------------------------------------------------
// validateHubConfig
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    relay_url: "https://relay.example.com",
    hub_name: "test-hub",
    subnode_idle_timeout_seconds: 300,
    subnode_rpc_timeout_seconds: 30,
    subnode_uid: {},
    subnode_gid: {},
    labels: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
    ...overrides,
  };
}

describe("validateHubConfig", () => {
  it("passes a well-formed config with no warnings", () => {
    const result = validateHubConfig(baseConfig());
    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("rejects a non-positive subnode_rpc_timeout_seconds", () => {
    const result = validateHubConfig(baseConfig({ subnode_rpc_timeout_seconds: 0 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_rpc_timeout_seconds must be a positive integer");
  });

  it("rejects an inverted allowed_range", () => {
    const result = validateHubConfig(baseConfig({ subnode_uid: { allowed_range: { min: 5000, max: 1000 } } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_uid.allowed_range.min must be <= max");
  });

  it("rejects an inverted blocked_range", () => {
    const result = validateHubConfig(baseConfig({ subnode_uid: { blocked_range: { min: 5000, max: 1000 } } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_uid.blocked_range.min must be <= max");
  });

  it("warns when allow_preferred_username is enabled", () => {
    const result = validateHubConfig(baseConfig({
      identity: { claims: [], user_map: [], allow_preferred_username: true },
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining("identity.allow_preferred_username is true"),
    ]);
  });

  it("rejects duplicate label names", () => {
    const label = { name: "docs", path: "/srv/docs", permissions: { default: "read-only" as const, overrides: [] } };
    const result = validateHubConfig(baseConfig({ labels: [label, { ...label, path: "/srv/docs2" }] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Duplicate label name: docs");
  });
});
