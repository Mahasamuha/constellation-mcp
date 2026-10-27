import { afterEach, describe, expect, it, vi } from "vitest";

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
