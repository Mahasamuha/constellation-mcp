import { describe, it, expect } from "vitest";
import { isSpecialUse, safeFetchJson, SafeFetchError } from "./safe-fetch.js";

describe("isSpecialUse", () => {
  it.each([
    "10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "0.0.0.0", "169.254.169.254", "100.64.0.1", "224.0.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "2002::1", "64:ff9b::1",
    "not-an-ip",
  ])("refuses %s", (addr) => {
    expect(isSpecialUse(addr)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (addr) => {
    expect(isSpecialUse(addr)).toBe(false);
  });
});

describe("safeFetchJson", () => {
  const opts = { maxBytes: 1024, timeoutMs: 1000 };

  it("rejects http URLs", async () => {
    await expect(safeFetchJson("http://example.com/client.json", opts)).rejects.toThrow(SafeFetchError);
  });

  it.each([
    "https://127.0.0.1/client.json",
    "https://10.0.0.5/client.json",
    "https://[::1]/client.json",
    "https://[::ffff:127.0.0.1]/client.json",
    "https://[fd00::1]/client.json",
  ])("rejects special-use IP literal %s", async (url) => {
    await expect(safeFetchJson(url, opts)).rejects.toThrow("disallowed address");
  });
});
