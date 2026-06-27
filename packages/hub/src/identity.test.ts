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

import { getpwnam, resolveIdentity, isIdentityError } from "./identity.js";
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
  return { claims: [], user_map: [], allow_preferred_username: false, ...overrides };
}

// ---------------------------------------------------------------------------
// getpwnam
// ---------------------------------------------------------------------------

describe("getpwnam", () => {
  it("returns uid/gid/home for a resolvable user", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    await expect(getpwnam("alice")).resolves.toEqual({ uid: 1001, gid: 1001, home: "/home/alice" });
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
    await expect(getpwnam("svc")).resolves.toEqual({ uid: 999, gid: 999, home: "/" });
  });
});

// ---------------------------------------------------------------------------
// resolveIdentity — three-tier chain
// ---------------------------------------------------------------------------

describe("resolveIdentity", () => {
  it("tier 1: resolves via a configured OIDC claim before consulting user_map", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    const config = identityConfig({
      claims: ["preferred_username"],
      user_map: [{ oidc_sub: "sub-1", local_username: "someone-else" }],
    });

    const result = await resolveIdentity({ preferred_username: "alice" }, "sub-1", config);

    expect(isIdentityError(result)).toBe(false);
    expect(result).toMatchObject({ username: "alice", uid: 1001, gid: 1001, home: "/home/alice" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("tier 1: skips claims that don't resolve to an OS account and falls through", async () => {
    execFileMock
      .mockReturnValueOnce(notFound()) // claim "uid" -> "ghost" doesn't exist
      .mockReturnValueOnce(passwdLine("bob", 1002, 1002)); // user_map entry resolves

    const config = identityConfig({
      claims: ["uid"],
      user_map: [{ oidc_sub: "sub-2", local_username: "bob" }],
    });

    const result = await resolveIdentity({ uid: "ghost" }, "sub-2", config);

    expect(isIdentityError(result)).toBe(false);
    expect(result).toMatchObject({ username: "bob" });
  });

  it("tier 2: hard-rejects when a user_map entry points to a nonexistent local account (no fallthrough to tier 3)", async () => {
    execFileMock.mockReturnValueOnce(notFound());
    const config = identityConfig({
      user_map: [{ oidc_sub: "sub-3", local_username: "nobody" }],
      allow_preferred_username: true,
    });

    const result = await resolveIdentity({ preferred_username: "alice" }, "sub-3", config);

    expect(isIdentityError(result)).toBe(true);
    if (isIdentityError(result)) {
      expect(result.message).toContain("Could not resolve an OS identity");
    }
    // Tier 3 must not have been attempted — only the user_map lookup ran.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("tier 3: ignores preferred_username when allow_preferred_username is disabled (the default)", async () => {
    const config = identityConfig({ allow_preferred_username: false });

    const result = await resolveIdentity({ preferred_username: "alice" }, null, config);

    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("tier 3: resolves preferred_username when explicitly enabled", async () => {
    execFileMock.mockReturnValueOnce(passwdLine("alice", 1001, 1001));
    const config = identityConfig({ allow_preferred_username: true });

    const result = await resolveIdentity({ preferred_username: "alice" }, null, config);

    expect(isIdentityError(result)).toBe(false);
    expect(result).toMatchObject({ username: "alice" });
  });

  it("returns a generic identity error when no tier resolves", async () => {
    const config = identityConfig();

    const result = await resolveIdentity({}, null, config);

    expect(isIdentityError(result)).toBe(true);
    if (isIdentityError(result)) {
      expect(result.message).toBe("Could not resolve an OS identity for this user. Contact the hub administrator.");
    }
  });

  it("never falls through to an envelope-supplied identity outside the three tiers", async () => {
    // No claims configured, sub not in user_map, preferred_username disabled —
    // even though the envelope carries a username-shaped claim, it must be ignored.
    const config = identityConfig();

    const result = await resolveIdentity({ preferred_username: "root", sub: "whoever" }, "unmapped-sub", config);

    expect(isIdentityError(result)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
