import { describe, it, expect } from "vitest";
import { checkPermission, checkRpcPermission, buildPermissionBlob } from "./permissions.js";
import type { ShareConfig } from "./config.js";

function share(overrides: Partial<ShareConfig["permissions"]> = {}, name = "docs"): ShareConfig {
  return {
    name,
    path: "/srv/docs",
    permissions: {
      default: "read-only",
      overrides: [],
      ...overrides,
    },
  };
}

const READ_TOOLS = ["list_directory", "file_info", "find_files", "read_file", "grep_files"];
const WRITE_TOOLS = ["write_file", "edit_file", "create_directory", "delete", "move", "copy"];

describe("checkPermission", () => {
  it("rejects shares that are not in the admin config", () => {
    const result = checkPermission(null, "missing", "read_file", [share()]);
    expect(result).toEqual({ permitted: false, reason: "Share 'missing' is not in the admin share config" });
  });

  it("rejects all access when the default level is none", () => {
    const shares = [share({ default: "none" })];
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(checkPermission(null, "docs", tool, shares)).toEqual({
        permitted: false,
        reason: "Access to share 'docs' is denied",
      });
    }
  });

  it("allows reads but rejects writes when the default level is read-only", () => {
    const shares = [share({ default: "read-only" })];
    for (const tool of READ_TOOLS) {
      expect(checkPermission(null, "docs", tool, shares)).toEqual({ permitted: true, access: "read-only" });
    }
    for (const tool of WRITE_TOOLS) {
      expect(checkPermission(null, "docs", tool, shares)).toEqual({
        permitted: false,
        reason: "Share 'docs' is read-only; write operations are not permitted",
      });
    }
  });

  it("allows everything when the default level is read-write", () => {
    const shares = [share({ default: "read-write" })];
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(checkPermission(null, "docs", tool, shares)).toEqual({ permitted: true, access: "read-write" });
    }
  });

  it("applies a per-user override over the default", () => {
    const shares = [share({
      default: "read-only",
      overrides: [{ oidc_sub: "user-1", access: "read-write" }],
    })];

    expect(checkPermission("user-1", "docs", "write_file", shares)).toEqual({ permitted: true, access: "read-write" });
    expect(checkPermission("user-2", "docs", "write_file", shares)).toEqual({
      permitted: false,
      reason: "Share 'docs' is read-only; write operations are not permitted",
    });
  });

  it("an override of 'none' takes precedence over a more permissive default", () => {
    const shares = [share({
      default: "read-write",
      overrides: [{ oidc_sub: "blocked-user", access: "none" }],
    })];

    expect(checkPermission("blocked-user", "docs", "read_file", shares)).toEqual({
      permitted: false,
      reason: "Access to share 'docs' is denied",
    });
    expect(checkPermission("other-user", "docs", "read_file", shares)).toEqual({ permitted: true, access: "read-write" });
  });

  it("ignores overrides when no oidcSub is provided", () => {
    const shares = [share({
      default: "read-only",
      overrides: [{ oidc_sub: "user-1", access: "read-write" }],
    })];

    expect(checkPermission(null, "docs", "write_file", shares)).toEqual({
      permitted: false,
      reason: "Share 'docs' is read-only; write operations are not permitted",
    });
  });
});

describe("checkRpcPermission", () => {
  const docs = share({ default: "read-write" }, "docs");
  const scratch = share({
    default: "read-only",
    overrides: [{ oidc_sub: "user-1", access: "read-write" }],
  }, "scratch");
  const priv = share({ default: "none" }, "private");
  const shares = [docs, scratch, priv];

  it("permits a same-share operation when the source share allows it", () => {
    expect(checkRpcPermission("user-1", "docs", null, "read_file", shares)).toEqual({ permitted: true });
  });

  it("rejects based on the source share, regardless of dst_share", () => {
    expect(checkRpcPermission(null, "private", "docs", "copy", shares)).toEqual({
      permitted: false,
      share: "private",
      reason: "Access to share 'private' is denied",
    });
  });

  it("rejects cross-share copy/move when the user lacks write access to dst_share", () => {
    // user-2 has read-write on "docs" (source, via default) but only the read-only default on "scratch" (dest).
    expect(checkRpcPermission("user-2", "docs", "scratch", "copy", shares)).toEqual({
      permitted: false,
      share: "scratch",
      reason: "Share 'scratch' is read-only; write operations are not permitted",
    });
  });

  it("permits cross-share copy/move when the user has write access to both shares", () => {
    // user-1 has read-write on "docs" (default) and on "scratch" (override).
    expect(checkRpcPermission("user-1", "docs", "scratch", "copy", shares)).toEqual({ permitted: true });
  });

  it("rejects cross-share copy/move when dst_share is not in the admin share config", () => {
    expect(checkRpcPermission("user-1", "docs", "missing", "move", shares)).toEqual({
      permitted: false,
      share: "missing",
      reason: "Share 'missing' is not in the admin share config",
    });
  });
});

describe("buildPermissionBlob", () => {
  it("carries the default and overrides through unchanged", () => {
    const s = share({
      default: "read-write",
      overrides: [{ oidc_sub: "user-1", access: "read-only" }],
    });

    expect(buildPermissionBlob(s)).toEqual({
      default: "read-write",
      overrides: [{ oidc_sub: "user-1", access: "read-only" }],
    });
  });
});
