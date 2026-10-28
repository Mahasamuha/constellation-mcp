import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
    const result = execFileMock(...args.slice(0, -1));
    if (result instanceof Error) cb(result);
    else cb(null, result);
  },
}));

import { getpwnam, resolveIdentity, isIdentityError, USERNAME_PATTERN } from "./identity.js";
import type { IdentityConfig } from "./config.js";

/** passwd line: name:passwd:uid:gid:gecos:home:shell */
function passwdLine(name: string, uid: number, gid: number, home = `/home/${name}`): { stdout: string; stderr: string } {
  return { stdout: `${name}:x:${uid}:${gid}:${name}:${home}:/bin/bash\n`, stderr: "" };
}

function notFound(): Error {
  return Object.assign(new Error("getent: not found"), { code: 2 });
}

beforeEach(() => {
  execFileMock.mockReset();
});

function identityConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return { claims: [], user_map: [], ...overrides };
}

// ---------------------------------------------------------------------------
// getpwnam
// ---------------------------------------------------------------------------

describe("getpwnam", () => {
  it("returns name/uid/gid/home for a resolvable user", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    await expect(getpwnam("alice")).resolves.toEqual({ name: "alice", uid: 1001, gid: 1001, home: "/home/alice" });
  });

  it("returns null for an unknown user", async () => {
    execFileMock.mockReturnValueOnce(notFound());
    await expect(getpwnam("ghost")).resolves.toBeNull();
  });

  it("returns null for an empty username without shelling out", async () => {
    await expect(getpwnam("")).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to '/' when the passwd entry has no home directory", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("svc", 999, 999, ""));
    await expect(getpwnam("svc")).resolves.toEqual({ name: "svc", uid: 999, gid: 999, home: "/" });
  });
});

// ---------------------------------------------------------------------------
// resolveIdentity — two-tier chain with untrusted claim values
// ---------------------------------------------------------------------------

const GENERIC = "Could not resolve an OS identity for this user. Contact the hub administrator.";
const claimsCfg = (extra: Partial<IdentityConfig> = {}) => identityConfig({ claims: ["constellation_username"], ...extra });

describe("USERNAME_PATTERN", () => {
  it.each(["alice", "Alice", "_svc", "a", "first.last", "user@domain.example", "a-b_c.d", "A".repeat(256)])("accepts %s", (v) => {
    expect(USERNAME_PATTERN.test(v)).toBe(true);
  });

  it.each([
    "", "1000", "+1000", "01000", " alice", "alice ", "al ice", "-alice", ".alice", "@alice", "a:b", "a/b", "a\\b",
    "alice\n", "al\0ice", "\talice", "alicé", "ａlice", "A".repeat(257),
  ])("rejects %j", (v) => {
    expect(USERNAME_PATTERN.test(v)).toBe(false);
  });
});

describe("resolveIdentity", () => {
  it("tier 1: resolves via the claim and uses the passwd name", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    const result = await resolveIdentity({ constellation_username: "alice" }, "sub-1", claimsCfg({
      user_map: [{ sub: "sub-1", local_username: "someone-else" }],
    }));
    expect(isIdentityError(result)).toBe(false);
    expect(result).toMatchObject({ username: "alice", uid: 1001, gid: 1001, home: "/home/alice" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a mixed-case name when the passwd name matches exactly", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("Alice.Smith", 1001, 1001));
    const result = await resolveIdentity({ constellation_username: "Alice.Smith" }, "s", claimsCfg());
    expect(result).toMatchObject({ username: "Alice.Smith" });
  });

  it("accepts an SSSD-style user@domain name", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("user@domain.example", 20001, 20001));
    const result = await resolveIdentity({ constellation_username: "user@domain.example" }, "s", claimsCfg());
    expect(result).toMatchObject({ username: "user@domain.example", uid: 20001 });
  });

  it.each([
    ["numeric", "1000"],
    ["plus-prefixed", "+1000"],
    ["zero-padded", "01000"],
    ["leading whitespace", " alice"],
    ["trailing whitespace", "alice "],
    ["trailing newline", "alice\n"],
    ["leading dash", "-alice"],
    ["colon", "alice:x"],
    ["path-like", "../alice"],
    ["empty string", ""],
  ])("tier 1: hard-refuses a %s claim without consulting getent, and does not fall through to user_map", async (_label, value) => {
    const result = await resolveIdentity({ constellation_username: value }, "sub-1", claimsCfg({
      user_map: [{ sub: "sub-1", local_username: "bob" }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an array", ["alice"]],
    ["an object", { name: "alice" }],
    ["a number", 1000],
    ["a boolean", true],
    ["null", null],
  ])("tier 1: hard-refuses a claim that is %s", async (_label, value) => {
    const result = await resolveIdentity({ constellation_username: value }, "sub-1", claimsCfg({
      user_map: [{ sub: "sub-1", local_username: "bob" }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("tier 1: refuses when getent returns a different passwd name than the claim (UID or alias match)", async () => {
    // A valid-looking claim for which NSS answers with another account's entry.
    execFileMock.mockReturnValueOnce(passwdLine("root", 0, 0));
    const result = await resolveIdentity({ constellation_username: "admin" }, "s", claimsCfg());
    expect(isIdentityError(result)).toBe(true);
  });

  it("tier 1: the name comparison is case-sensitive", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    const result = await resolveIdentity({ constellation_username: "Alice" }, "s", claimsCfg());
    expect(isIdentityError(result)).toBe(true);
  });

  it("tier 1: refuses (no fall-through) when the claim names a user that does not exist", async () => {
    execFileMock.mockReturnValueOnce(notFound());
    const result = await resolveIdentity({ constellation_username: "ghost" }, "sub-2", claimsCfg({
      user_map: [{ sub: "sub-2", local_username: "bob" }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("tier 2: an absent claim moves on to user_map", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("bob", 1002, 1002));
    const result = await resolveIdentity({ email: "b@example.com" }, "sub-2", claimsCfg({
      user_map: [{ sub: "sub-2", local_username: "bob" }],
    }));
    expect(isIdentityError(result)).toBe(false);
    expect(result).toMatchObject({ username: "bob" });
  });

  it("tier 2: an inherited property name is not treated as a present claim", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("bob", 1002, 1002));
    const result = await resolveIdentity({}, "sub-2", identityConfig({
      claims: ["constructor"],
      user_map: [{ sub: "sub-2", local_username: "bob" }],
    }));
    expect(result).toMatchObject({ username: "bob" });
  });

  it("tier 2: refuses when the mapped username does not exist", async () => {
    execFileMock.mockReturnValueOnce(notFound());
    const result = await resolveIdentity({}, "sub-3", identityConfig({
      user_map: [{ sub: "sub-3", local_username: "nobody" }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each(["1000", "+1000", "01000", " bob", "bob "])("tier 2: refuses a user_map local_username of %j without consulting getent", async (name) => {
    const result = await resolveIdentity({}, "sub-3", identityConfig({
      user_map: [{ sub: "sub-3", local_username: name }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("tier 2: refuses a user_map entry whose passwd name differs", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("root", 0, 0));
    const result = await resolveIdentity({}, "sub-3", identityConfig({
      user_map: [{ sub: "sub-3", local_username: "admin" }],
    }));
    expect(isIdentityError(result)).toBe(true);
  });

  it("matches user_map on sub exactly", async () => {
    const result = await resolveIdentity({}, "SUB-3", identityConfig({
      user_map: [{ sub: "sub-3", local_username: "bob" }],
    }));
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("there is no preferred_username tier: the claim is ignored", async () => {
    const result = await resolveIdentity({ preferred_username: "alice" }, "sub-9", identityConfig());
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns a generic identity error when no tier resolves", async () => {
    const result = await resolveIdentity({}, "sub-9", identityConfig());
    expect(result).toEqual({ kind: "identity_error", message: GENERIC });
  });

  it("never falls through to an envelope-supplied identity outside the two tiers", async () => {
    const result = await resolveIdentity({ preferred_username: "root", sub: "whoever" }, "unmapped-sub", identityConfig());
    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
