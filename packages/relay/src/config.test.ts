import { afterEach, describe, expect, it, vi } from "vitest";

async function assertOrigin(relayUrl: string) {
  vi.resetModules();
  vi.stubEnv("RELAY_URL", relayUrl);
  return (await import("./config.js")).assertRelayUrlIsOrigin();
}

describe("assertRelayUrlIsOrigin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts https, and http only on loopback", async () => {
    await expect(assertOrigin("https://relay.example.com")).resolves.toBeUndefined();
    await expect(assertOrigin("http://localhost:3000")).resolves.toBeUndefined();
    await expect(assertOrigin("http://127.0.0.1:3000")).resolves.toBeUndefined();
    await expect(assertOrigin("http://[::1]:3000")).resolves.toBeUndefined();
  });

  it("refuses plaintext http on a non-loopback host", async () => {
    await expect(assertOrigin("http://relay.example.com")).rejects.toThrow("https");
    await expect(assertOrigin("http://10.0.0.5:3000")).rejects.toThrow("https");
  });

  it("still refuses a path or trailing slash", async () => {
    await expect(assertOrigin("https://relay.example.com/")).rejects.toThrow("bare origin");
  });
});

describe("config.adminGroup", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to constellation-admins and reads ADMIN_GROUP", async () => {
    vi.resetModules();
    vi.stubEnv("ADMIN_GROUP", "");
    expect((await import("./config.js")).config.adminGroup).toBe("constellation-admins");
    vi.resetModules();
    vi.stubEnv("ADMIN_GROUP", "ops");
    expect((await import("./config.js")).config.adminGroup).toBe("ops");
  });
});

describe("assertAsterismConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function run(issuer: string | undefined, relayUrl: string | undefined) {
    vi.resetModules();
    if (issuer !== undefined) vi.stubEnv("ASTERISM_ISSUER", issuer);
    else vi.stubEnv("ASTERISM_ISSUER", "");
    vi.stubEnv("RELAY_URL", relayUrl ?? "");
    return (await import("./config.js")).assertAsterismConfig();
  }

  it("accepts an https issuer with RELAY_URL set", async () => {
    await expect(run("https://auth.example.com", "https://relay.example.com")).resolves.toBeUndefined();
  });

  it("accepts http only on a loopback host", async () => {
    await expect(run("http://localhost:4000", "http://localhost:3000")).resolves.toBeUndefined();
    await expect(run("http://127.0.0.1:4000", "http://localhost:3000")).resolves.toBeUndefined();
    await expect(run("http://auth.example.com", "https://relay.example.com")).rejects.toThrow("https");
  });

  it("rejects a missing or malformed issuer", async () => {
    await expect(run(undefined, "https://relay.example.com")).rejects.toThrow("ASTERISM_ISSUER is required");
    await expect(run("not a url", "https://relay.example.com")).rejects.toThrow("not a valid URL");
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(run("ftp://auth.example.com", "https://relay.example.com")).rejects.toThrow("https");
  });

  it("requires RELAY_URL", async () => {
    await expect(run("https://auth.example.com", undefined)).rejects.toThrow("RELAY_URL is required");
  });
});
