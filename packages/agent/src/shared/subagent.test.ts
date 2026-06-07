import { describe, it, expect, vi } from "vitest";

vi.mock("node:os", () => ({ userInfo: () => ({ uid: 2000, gid: 2000 }) }));

import { checkUidRestrictions } from "./subagent.js";
import type { SharedAgentConfig, SubagentUidConfig } from "./config.js";

function configWith(subagent_uid: SubagentUidConfig): SharedAgentConfig {
  return {
    broker_url: "https://broker.example.com",
    agent_name: "test-agent",
    subagent_idle_timeout_seconds: 300,
    subagent_rpc_timeout_seconds: 30,
    subagent_uid,
    labels: [],
    identity: { claims: [], user_map: [], allow_preferred_username: false },
    audit_log: "/var/log/constellation/audit.jsonl",
  };
}

describe("checkUidRestrictions", () => {
  it("always blocks UID 0 (root), regardless of config", () => {
    expect(checkUidRestrictions(0, configWith({ allowed_range: { min: 0, max: 65535 } })))
      .toMatch(/UID 0 \(root\) is always blocked/);
  });

  it("always blocks the shared agent's own UID", () => {
    // userInfo() is mocked to uid 2000 above
    expect(checkUidRestrictions(2000, configWith({})))
      .toMatch(/matches the shared agent process UID/);
  });

  it("allows an ordinary UID with no restrictions configured", () => {
    expect(checkUidRestrictions(1001, configWith({}))).toBeNull();
  });

  it("blocks UIDs in the explicit blocklist", () => {
    expect(checkUidRestrictions(1050, configWith({ blocked_uids: [1050] })))
      .toMatch(/UID 1050 is explicitly blocked/);
    expect(checkUidRestrictions(1051, configWith({ blocked_uids: [1050] }))).toBeNull();
  });

  it("blocks UIDs within a blocked range", () => {
    const cfg = configWith({ blocked_range: { min: 1, max: 999 } });
    expect(checkUidRestrictions(500, cfg)).toMatch(/falls within blocked range \[1, 999\]/);
    expect(checkUidRestrictions(1000, cfg)).toBeNull();
  });

  it("rejects UIDs outside an allowed range", () => {
    const cfg = configWith({ allowed_range: { min: 1000, max: 60000 } });
    expect(checkUidRestrictions(999, cfg)).toMatch(/UID 999 is outside allowed range \[1000, 60000\]/);
    expect(checkUidRestrictions(60001, cfg)).toMatch(/UID 60001 is outside allowed range \[1000, 60000\]/);
    expect(checkUidRestrictions(1000, cfg)).toBeNull();
    expect(checkUidRestrictions(60000, cfg)).toBeNull();
  });

  it("evaluates blocklist/blocked-range before allowed-range", () => {
    // A UID inside the allowed range but explicitly blocked must still be rejected.
    const cfg = configWith({ allowed_range: { min: 1000, max: 60000 }, blocked_uids: [1500] });
    expect(checkUidRestrictions(1500, cfg)).toMatch(/UID 1500 is explicitly blocked/);
  });

  it("treats an open-ended range bound as unbounded", () => {
    expect(checkUidRestrictions(99999, configWith({ allowed_range: { min: 1000 } }))).toBeNull();
    expect(checkUidRestrictions(1, configWith({ allowed_range: { max: 60000 } }))).toBeNull();
  });
});
