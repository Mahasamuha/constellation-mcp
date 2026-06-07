import { describe, it, expect } from "vitest";
import { checkPermission, buildPermissionBlob } from "./permissions.js";
import type { LabelConfig } from "./config.js";

function label(overrides: Partial<LabelConfig["permissions"]> = {}, name = "docs"): LabelConfig {
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
  it("rejects labels that are not in the admin config", () => {
    const result = checkPermission(null, "missing", "read_file", [label()]);
    expect(result).toEqual({ permitted: false, reason: "Label 'missing' is not in the admin label config" });
  });

  it("rejects all access when the default level is none", () => {
    const labels = [label({ default: "none" })];
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(checkPermission(null, "docs", tool, labels)).toEqual({
        permitted: false,
        reason: "Access to label 'docs' is denied",
      });
    }
  });

  it("allows reads but rejects writes when the default level is read-only", () => {
    const labels = [label({ default: "read-only" })];
    for (const tool of READ_TOOLS) {
      expect(checkPermission(null, "docs", tool, labels)).toEqual({ permitted: true, access: "read-only" });
    }
    for (const tool of WRITE_TOOLS) {
      expect(checkPermission(null, "docs", tool, labels)).toEqual({
        permitted: false,
        reason: "Label 'docs' is read-only; write operations are not permitted",
      });
    }
  });

  it("allows everything when the default level is read-write", () => {
    const labels = [label({ default: "read-write" })];
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(checkPermission(null, "docs", tool, labels)).toEqual({ permitted: true, access: "read-write" });
    }
  });

  it("applies a per-user override over the default", () => {
    const labels = [label({
      default: "read-only",
      overrides: [{ oidc_sub: "user-1", access: "read-write" }],
    })];

    expect(checkPermission("user-1", "docs", "write_file", labels)).toEqual({ permitted: true, access: "read-write" });
    expect(checkPermission("user-2", "docs", "write_file", labels)).toEqual({
      permitted: false,
      reason: "Label 'docs' is read-only; write operations are not permitted",
    });
  });

  it("an override of 'none' takes precedence over a more permissive default", () => {
    const labels = [label({
      default: "read-write",
      overrides: [{ oidc_sub: "blocked-user", access: "none" }],
    })];

    expect(checkPermission("blocked-user", "docs", "read_file", labels)).toEqual({
      permitted: false,
      reason: "Access to label 'docs' is denied",
    });
    expect(checkPermission("other-user", "docs", "read_file", labels)).toEqual({ permitted: true, access: "read-write" });
  });

  it("ignores overrides when no oidcSub is provided", () => {
    const labels = [label({
      default: "read-only",
      overrides: [{ oidc_sub: "user-1", access: "read-write" }],
    })];

    expect(checkPermission(null, "docs", "write_file", labels)).toEqual({
      permitted: false,
      reason: "Label 'docs' is read-only; write operations are not permitted",
    });
  });
});

describe("buildPermissionBlob", () => {
  it("carries the default and overrides through unchanged", () => {
    const l = label({
      default: "read-write",
      overrides: [{ oidc_sub: "user-1", access: "read-only" }],
    });

    expect(buildPermissionBlob(l)).toEqual({
      default: "read-write",
      overrides: [{ oidc_sub: "user-1", access: "read-only" }],
    });
  });
});
