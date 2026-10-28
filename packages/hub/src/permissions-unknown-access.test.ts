import { describe, it, expect, vi } from "vitest";

// Bypass the shared evaluator to prove checkPermission denies on its own.
vi.mock("@constellation/shared", async (orig) => ({
  ...(await orig<typeof import("@constellation/shared")>()),
  evaluatePermissionBlob: () => "admin",
}));

import { checkPermission } from "./permissions.js";

describe("checkPermission — defence in depth", () => {
  it("denies an access level that is neither read-only nor read-write", () => {
    const shares = [{ name: "docs", path: "/srv/docs", permissions: { default: "read-write" as const, overrides: [] } }];
    for (const tool of ["read_file", "write_file"]) {
      expect(checkPermission({ sub: "u", groups: [] }, "docs", tool, shares)).toMatchObject({ permitted: false });
    }
  });
});
