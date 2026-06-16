import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeTempDir, cleanTempDir } from "./test/fixtures.js";
import { loadHubConfig, validateHubConfig, MIN_WORKER_IDLE_SECONDS, type HubConfig } from "./config.js";

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
    expect(cfg.subnode_rpc_timeout_seconds).toBe(30);
    expect(cfg.subnode_workers).toEqual({
      min: 1,
      max: 1,
      warm_idle_seconds: 300,
      burst_idle_seconds: 30,
      queue_timeout: 0.5,
    });
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

  it("parses subnode_workers and identity config", async () => {
    const path = await writeConfig(`
relay_url: https://relay.example.com
hub_name: test-hub
audit_log: /var/log/constellation/audit.jsonl
subnode_rpc_timeout_seconds: 15
subnode_workers:
  min: 2
  max: 4
  warm_idle_seconds: 120
  burst_idle_seconds: 45
  queue_timeout: 5
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

    expect(cfg.subnode_rpc_timeout_seconds).toBe(15);
    expect(cfg.subnode_workers).toEqual({
      min: 2,
      max: 4,
      warm_idle_seconds: 120,
      burst_idle_seconds: 45,
      queue_timeout: 5,
    });
    expect(cfg.labels[0]!.permissions.overrides).toEqual([{ oidc_sub: "user-1", access: "read-write" }]);
    expect(cfg.identity).toEqual({
      claims: ["uid", "sAMAccountName"],
      user_map: [{ oidc_sub: "sub-1", local_username: "alice" }],
      allow_preferred_username: true,
    });
  });

  it("defaults max to min when only min is specified", async () => {
    const path = await writeConfig(BASE_YAML + "\nsubnode_workers:\n  min: 3\n");
    const cfg = loadHubConfig(path);
    expect(cfg.subnode_workers.min).toBe(3);
    expect(cfg.subnode_workers.max).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// validateHubConfig
// ---------------------------------------------------------------------------

function baseConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    relay_url: "https://relay.example.com",
    hub_name: "test-hub",
    subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.5 },
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

  it("rejects subnode_workers.min < 1", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 0, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.5 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_workers.min must be >= 1");
  });

  it("rejects subnode_workers.max < min", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 3, max: 2, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.5 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_workers.max must be >= subnode_workers.min");
  });

  it("rejects warm_idle_seconds below the floor", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: MIN_WORKER_IDLE_SECONDS - 1, burst_idle_seconds: 30, queue_timeout: 0.5 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`subnode_workers.warm_idle_seconds must be >= ${MIN_WORKER_IDLE_SECONDS}`);
  });

  it("rejects burst_idle_seconds below the floor", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: MIN_WORKER_IDLE_SECONDS - 1, queue_timeout: 0.5 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`subnode_workers.burst_idle_seconds must be >= ${MIN_WORKER_IDLE_SECONDS}`);
  });

  it("rejects queue_timeout <= 0", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0 },
    }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("subnode_workers.queue_timeout must be > 0");
  });

  it("warns when queue_timeout fraction is below the recommended range", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.1 },
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining("subnode_workers.queue_timeout (0.1) is a fraction"),
    ]);
  });

  it("warns when queue_timeout fraction is above the recommended range", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.95 },
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringContaining("subnode_workers.queue_timeout (0.95) is a fraction"),
    ]);
  });

  it("does not warn for a queue_timeout fraction within [0.3, 0.8]", () => {
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 0.5 },
    }));
    expect(result.warnings).toEqual([]);
  });

  it("does not warn for an integer queue_timeout, even outside [0.3, 0.8] as a fraction", () => {
    // Integers are explicit seconds, not a fraction of subnode_rpc_timeout_seconds —
    // the [0.3, 0.8] recommendation does not apply.
    const result = validateHubConfig(baseConfig({
      subnode_workers: { min: 1, max: 1, warm_idle_seconds: 300, burst_idle_seconds: 30, queue_timeout: 5 },
    }));
    expect(result.warnings).toEqual([]);
  });
});
