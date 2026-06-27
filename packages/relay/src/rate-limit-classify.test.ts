import { describe, it, expect } from "vitest";
import { classifyHttpRoute } from "./rate-limit-classify.js";

describe("classifyHttpRoute", () => {
  it("routes /mcp to exempt — already rate-limited per-user inside tool dispatch", () => {
    expect(classifyHttpRoute("/mcp")).toBe("exempt");
  });

  it("routes plain oauth endpoints to the oauth bucket", () => {
    for (const path of ["/oauth/register", "/oauth/device/code", "/setup", "/auth/login"]) {
      expect(classifyHttpRoute(path)).toBe("oauth");
    }
  });

  it("splits /oauth/token by grant_type — device-code polling gets its own bucket", () => {
    expect(classifyHttpRoute("/oauth/token", "urn:ietf:params:oauth:grant-type:device_code")).toBe("device-poll");
    expect(classifyHttpRoute("/oauth/token", "authorization_code")).toBe("oauth");
    expect(classifyHttpRoute("/oauth/token", undefined)).toBe("oauth");
  });

  it("routes every /activate* path to the device-auth bucket", () => {
    for (const path of ["/activate", "/activate/login", "/activate/callback", "/activate/confirm"]) {
      expect(classifyHttpRoute(path)).toBe("device-auth");
    }
  });

  it("falls through to the strict default bucket for anything not explicitly classified", () => {
    for (const path of ["/api/executors", "/api/admin/users/x/promote", "/some/future/route", "/"]) {
      expect(classifyHttpRoute(path)).toBe("default");
    }
  });
});
