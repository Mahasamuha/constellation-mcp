import { describe, it, expect } from "vitest";
import { evaluatePermissionBlob, groupsFromClaims, InvalidGroupsError, MAX_GROUPS, MAX_GROUP_LENGTH } from "./permissions.js";

describe("evaluatePermissionBlob", () => {
  const blob = {
    default: "none",
    overrides: [
      { group: "eng", access: "read-only" },
      { group: "ops", access: "read-write" },
      { sub: "u1", access: "none" },
    ],
  };

  it("uses the default when nothing matches", () => {
    expect(evaluatePermissionBlob(blob, { sub: "x", groups: [] })).toBe("none");
    expect(evaluatePermissionBlob({ default: "read-only" }, { sub: "x", groups: ["eng"] })).toBe("read-only");
  });

  it("falls back to none for an empty default", () => {
    expect(evaluatePermissionBlob({ default: "" }, { sub: null, groups: [] })).toBe("none");
  });

  it("applies the most permissive matching group", () => {
    expect(evaluatePermissionBlob(blob, { sub: "x", groups: ["eng"] })).toBe("read-only");
    expect(evaluatePermissionBlob(blob, { sub: "x", groups: ["eng", "ops"] })).toBe("read-write");
    expect(evaluatePermissionBlob(blob, { sub: "x", groups: ["ops", "eng"] })).toBe("read-write");
  });

  it("lets a sub override win outright, even over a more permissive group", () => {
    expect(evaluatePermissionBlob(blob, { sub: "u1", groups: ["ops"] })).toBe("none");
  });

  it("ignores sub overrides when there is no sub", () => {
    expect(evaluatePermissionBlob({ default: "read-write", overrides: [{ sub: "u1", access: "none" }] }, { sub: null, groups: [] })).toBe("read-write");
  });

  it("lets a group restrict below the default", () => {
    expect(evaluatePermissionBlob({ default: "read-write", overrides: [{ group: "c", access: "read-only" }] }, { sub: "x", groups: ["c"] })).toBe("read-only");
  });

  it("does not match groups by prefix or case", () => {
    expect(evaluatePermissionBlob(blob, { sub: "x", groups: ["engineering", "ENG"] })).toBe("none");
  });
});

describe("evaluatePermissionBlob — unknown access values", () => {
  it("maps an unknown default to none", () => {
    expect(evaluatePermissionBlob({ default: "admin" }, { sub: "x", groups: [] })).toBe("none");
    expect(evaluatePermissionBlob({ default: "toString" }, { sub: "x", groups: [] })).toBe("none");
  });

  it("maps an unknown sub override to none", () => {
    expect(evaluatePermissionBlob({ default: "read-write", overrides: [{ sub: "u", access: "rw" }] }, { sub: "u", groups: [] })).toBe("none");
  });

  it("maps an unknown group override to none", () => {
    expect(evaluatePermissionBlob({ default: "read-write", overrides: [{ group: "g", access: "full" }] }, { sub: "x", groups: ["g"] })).toBe("none");
  });
});

describe("groupsFromClaims", () => {
  it("returns a valid list unchanged", () => {
    expect(groupsFromClaims({ groups: ["a", "b"] })).toEqual(["a", "b"]);
    expect(groupsFromClaims({ groups: ["x".repeat(MAX_GROUP_LENGTH)] })).toHaveLength(1);
  });

  it("returns [] when the claim is absent", () => {
    expect(groupsFromClaims({})).toEqual([]);
    expect(groupsFromClaims({ groups: undefined })).toEqual([]);
  });

  it("throws for any present non-array shape", () => {
    for (const groups of ["a", { 0: "a" }, 5, null]) {
      expect(() => groupsFromClaims({ groups })).toThrow(InvalidGroupsError);
    }
  });

  it("throws rather than dropping an invalid entry", () => {
    for (const bad of ["", 3, null, { x: 1 }, "x".repeat(MAX_GROUP_LENGTH + 1)]) {
      expect(() => groupsFromClaims({ groups: ["a", bad] })).toThrow(InvalidGroupsError);
    }
  });

  it("throws rather than truncating an oversize list", () => {
    const many = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => `g${i}`);
    expect(() => groupsFromClaims({ groups: many })).toThrow(InvalidGroupsError);
    expect(groupsFromClaims({ groups: many.slice(0, MAX_GROUPS) })).toHaveLength(MAX_GROUPS);
  });
});
