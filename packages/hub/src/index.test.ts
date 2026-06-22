import { describe, it, expect } from "vitest";
import { resolveDstShare } from "./index.js";
import type { RpcEnvelope } from "@constellation/shared";

function envelope(params: Record<string, unknown> = {}, tool = "copy"): RpcEnvelope {
  return {
    request_id: "req-1",
    tool,
    share: "docs",
    absolute_root: "/srv/docs",
    params,
  };
}

const registry = { docs: "/srv/docs", other: "/srv/other" };

describe("resolveDstShare", () => {
  it("returns null for non copy/move tools, even if dst_share is present", () => {
    expect(resolveDstShare(envelope({ dst_share: "other" }, "read_file"), "read_file", registry)).toBeNull();
  });

  it("returns null when neither dst_share nor dst_root is present", () => {
    expect(resolveDstShare(envelope(), "copy", registry)).toBeNull();
  });

  it("prefers the client-supplied dst_share", () => {
    expect(resolveDstShare(envelope({ dst_share: "other", dst_root: "/srv/docs" }), "copy", registry)).toBe("other");
  });

  it("reverse-resolves dst_root to a share name when dst_share is absent", () => {
    expect(resolveDstShare(envelope({ dst_root: "/srv/other" }), "move", registry)).toBe("other");
  });

  it("returns null when dst_root doesn't match any registered share", () => {
    expect(resolveDstShare(envelope({ dst_root: "/srv/unregistered" }), "copy", registry)).toBeNull();
  });
});
