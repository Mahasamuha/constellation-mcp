import { afterEach, describe, expect, it, vi } from "vitest";

describe("assertDynamicClientTtl", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function load() {
    vi.resetModules();
    return (await import("./config.js")).assertDynamicClientTtl;
  }

  it("accepts the default and values >= 1", async () => {
    expect((await load())).not.toThrow();
    vi.stubEnv("OAUTH_DYNAMIC_CLIENT_TTL_HOURS", "1");
    expect((await load())).not.toThrow();
  });

  it("rejects 0", async () => {
    vi.stubEnv("OAUTH_DYNAMIC_CLIENT_TTL_HOURS", "0");
    expect((await load())).toThrow("at least 1");
  });
});
