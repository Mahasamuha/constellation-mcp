import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { isSpecialUse, readJsonResponse, safeFetchJson, SafeFetchError } from "./safe-fetch.js";

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

  it("rejects a host that resolves to a special-use address at DNS time", async () => {
    await expect(safeFetchJson("https://localhost/x", opts)).rejects.toThrow("disallowed address");
  });
});

describe("SafeFetchError", () => {
  it("preserves the underlying cause", () => {
    const cause = Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
    expect(new SafeFetchError("fetch failed", { cause }).cause).toBe(cause);
  });
});

describe("readJsonResponse", () => {
  function fakeRes(opts: { status?: number; headers?: Record<string, string>; chunks?: string[] }): IncomingMessage {
    const res = Readable.from((opts.chunks ?? ["{}"]).map((c) => Buffer.from(c))) as unknown as IncomingMessage;
    res.statusCode = opts.status ?? 200;
    res.headers = { "content-type": "application/json", ...opts.headers };
    return res;
  }

  it("returns the body and cache-control for a valid response", async () => {
    const res = fakeRes({ headers: { "cache-control": "max-age=60" }, chunks: ['{"a":', "1}"] });
    expect(await readJsonResponse(res, 1024)).toEqual({ body: '{"a":1}', cacheControl: "max-age=60" });
  });

  it("accepts +json and charset content types", async () => {
    await expect(readJsonResponse(fakeRes({ headers: { "content-type": "application/jwk+json; charset=utf-8" } }), 1024)).resolves.toBeDefined();
  });

  it.each([404, 500, 301, 302, 307])("treats status %i as a failure without following redirects", async (status) => {
    await expect(readJsonResponse(fakeRes({ status, headers: { location: "https://example.com/next" } }), 1024))
      .rejects.toThrow(`unexpected HTTP status ${status}`);
  });

  it("rejects a non-JSON content type", async () => {
    await expect(readJsonResponse(fakeRes({ headers: { "content-type": "text/html" } }), 1024)).rejects.toThrow("not JSON");
  });

  it("rejects a declared Content-Length over the cap", async () => {
    await expect(readJsonResponse(fakeRes({ headers: { "content-length": "2048" } }), 1024)).rejects.toThrow("too large");
  });

  it("rejects a streamed body over the cap", async () => {
    await expect(readJsonResponse(fakeRes({ chunks: ["x".repeat(600), "x".repeat(600)] }), 1024)).rejects.toThrow("too large");
  });

  it("wraps stream errors with the cause", async () => {
    const res = fakeRes({});
    const cause = new Error("reset");
    const bad = new Readable({ read() { this.destroy(cause); } }) as unknown as IncomingMessage;
    bad.statusCode = 200;
    bad.headers = res.headers;
    const err = await readJsonResponse(bad, 1024).catch((e) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err.cause).toBe(cause);
  });
});
