import { describe, it, expect } from "vitest";
import { evaluatePermissionBlob, groupsFromClaims, MAX_GROUPS } from "./permissions.js";

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

describe("groupsFromClaims", () => {
  it("returns non-empty strings only", () => {
    expect(groupsFromClaims({ groups: ["a", "", 3, null, "b", { x: 1 }] })).toEqual(["a", "b"]);
  });

  it("returns [] for any non-array shape", () => {
    for (const groups of ["a", { 0: "a" }, 5, null, undefined]) {
      expect(groupsFromClaims({ groups })).toEqual([]);
    }
    expect(groupsFromClaims({})).toEqual([]);
  });

  it("caps the count and drops over-long names", () => {
    const many = Array.from({ length: MAX_GROUPS + 10 }, (_, i) => `g${i}`);
    expect(groupsFromClaims({ groups: many })).toHaveLength(MAX_GROUPS);
    expect(groupsFromClaims({ groups: ["x".repeat(257), "ok"] })).toEqual(["ok"]);
  });
});
