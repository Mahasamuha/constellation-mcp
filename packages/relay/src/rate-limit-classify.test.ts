import { describe, it, expect } from "vitest";
import { classifyHttpRoute } from "./rate-limit-classify.js";

describe("classifyHttpRoute", () => {
  it("routes /mcp to exempt — already rate-limited per-user inside tool dispatch", () => {
    expect(classifyHttpRoute("/mcp")).toBe("exempt");
  });

  it("routes discovery metadata and client metadata documents to the static bucket", () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/clients/cli.json", "/clients/node.json", "/clients/hub.json"]) {
      expect(classifyHttpRoute(path)).toBe("static");
    }
  });

  it("keeps the authenticated executor registration on the strict default", () => {
    expect(classifyHttpRoute("/api/executors/register")).toBe("default");
  });

  it("falls through to the strict default bucket for anything not explicitly classified", () => {
    for (const path of ["/api/executors", "/clients/", "/clients/a/b.json", "/oauth/token", "/some/future/route", "/"]) {
      expect(classifyHttpRoute(path)).toBe("default");
    }
  });
});
