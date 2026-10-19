import { vi, describe, it, expect } from "vitest";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return { createLogger: () => ({ ...log, child: () => log }) };
});

vi.mock("./config.js", () => ({
  config: { oauthAllowedRedirectOrigins: ["https://claude.ai"], oauthDynamicClientTtlHours: 24 },
}));

vi.mock("./db.js", () => ({ prisma: {} }));
vi.mock("./safe-fetch.js", () => ({
  safeFetchJson: vi.fn(),
  SafeFetchError: class SafeFetchError extends Error {},
}));

import {
  cacheLifetimeMs,
  InvalidClientError,
  isAllowedRedirectUri,
  parseMetadataDocument,
  validateClientIdUrl,
} from "./oauth-clients.js";

const ID = "https://app.example.com/client.json";
const MIN = 5 * 60 * 1000;
const MAX = 24 * 60 * 60 * 1000;
const DEFAULT = 60 * 60 * 1000;

describe("validateClientIdUrl", () => {
  it("accepts a canonical https URL with a path", () => {
    expect(() => validateClientIdUrl(ID)).not.toThrow();
    expect(() => validateClientIdUrl("https://app.example.com:8443/a/b.json?x=1")).not.toThrow();
  });

  it.each([
    ["too long", `https://app.example.com/${"a".repeat(2000)}`, "too long"],
    ["non-canonical", "https://APP.example.com/client.json", "canonical"],
    ["userinfo", "https://user:pw@app.example.com/client.json", "userinfo"],
    ["fragment", "https://app.example.com/client.json#frag", "fragment"],
    ["root path", "https://app.example.com/", "path"],
    ["root path without slash", "https://app.example.com", "canonical"],
    ["dot segments", "https://app.example.com/a/../client.json", "canonical"],
    ["single dot segment", "https://app.example.com/./client.json", "canonical"],
    ["invalid URL", "https://", "valid URL"],
  ])("rejects %s", (_name, url, msg) => {
    expect(() => validateClientIdUrl(url)).toThrow(InvalidClientError);
    expect(() => validateClientIdUrl(url)).toThrow(msg);
  });
});

describe("parseMetadataDocument", () => {
  const valid = {
    client_id: ID,
    client_name: "  Example App ",
    redirect_uris: ["http://127.0.0.1:8080/cb"],
  };
  const parse = (doc: unknown) => parseMetadataDocument(ID, JSON.stringify(doc));

  it("parses a valid document and trims the name", () => {
    expect(parse(valid)).toEqual({
      clientName: "Example App",
      redirectUris: ["http://127.0.0.1:8080/cb"],
      grantTypes: ["authorization_code", "refresh_token"],
    });
  });

  it("keeps explicit grant_types", () => {
    expect(parse({ ...valid, grant_types: ["authorization_code"] }).grantTypes).toEqual(["authorization_code"]);
  });

  it("accepts token_endpoint_auth_method none", () => {
    expect(() => parse({ ...valid, token_endpoint_auth_method: "none" })).not.toThrow();
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(() => parseMetadataDocument(ID, "{nope")).toThrow("not valid JSON");
    expect(() => parse([])).toThrow("JSON object");
    expect(() => parse(null)).toThrow("JSON object");
  });

  it("rejects client_id mismatch", () => {
    expect(() => parse({ ...valid, client_id: "https://evil.example.com/client.json" })).toThrow("does not match");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["too long", "x".repeat(201)],
    ["non-string", 5],
  ])("rejects %s client_name", (_n, name) => {
    expect(() => parse({ ...valid, client_name: name })).toThrow("client_name");
  });

  it("rejects client secrets", () => {
    expect(() => parse({ ...valid, client_secret: "s" })).toThrow("secrets");
    expect(() => parse({ ...valid, client_secret_expires_at: 0 })).toThrow("secrets");
  });

  it("rejects auth methods other than none", () => {
    expect(() => parse({ ...valid, token_endpoint_auth_method: "client_secret_basic" })).toThrow("must be \"none\"");
  });

  it("requires redirect_uris", () => {
    expect(() => parse({ ...valid, redirect_uris: undefined })).toThrow("redirect_uris");
    expect(() => parse({ ...valid, redirect_uris: [] })).toThrow("redirect_uris");
  });

  it("drops disallowed redirect URIs but keeps allowed ones", () => {
    const r = parse({ ...valid, redirect_uris: ["https://evil.example.com/cb", "https://claude.ai/cb", "myapp://cb", 5] });
    expect(r.redirectUris).toEqual(["https://claude.ai/cb"]);
  });

  it("rejects when every redirect URI is disallowed", () => {
    expect(() => parse({ ...valid, redirect_uris: ["https://evil.example.com/cb", "myapp://cb"] })).toThrow("none of the client's redirect_uris");
  });
});

describe("cacheLifetimeMs", () => {
  it("defaults with no header or no max-age", () => {
    expect(cacheLifetimeMs(undefined)).toBe(DEFAULT);
    expect(cacheLifetimeMs("public")).toBe(DEFAULT);
  });

  it("uses max-age within bounds", () => {
    expect(cacheLifetimeMs("max-age=1800")).toBe(1800_000);
    expect(cacheLifetimeMs("public, Max-Age=1800")).toBe(1800_000);
  });

  it("clamps positive max-age to the min and max", () => {
    expect(cacheLifetimeMs("max-age=1")).toBe(MIN);
    expect(cacheLifetimeMs("max-age=99999999")).toBe(MAX);
  });

  it("returns 0 for no-store, no-cache and max-age=0", () => {
    expect(cacheLifetimeMs("no-store")).toBe(0);
    expect(cacheLifetimeMs("public, no-cache")).toBe(0);
    expect(cacheLifetimeMs("max-age=0")).toBe(0);
  });

  it("falls back to the default on garbage", () => {
    expect(cacheLifetimeMs("max-age=abc")).toBe(DEFAULT);
    expect(cacheLifetimeMs("max-age=-5")).toBe(DEFAULT);
  });
});

describe("isAllowedRedirectUri", () => {
  it.each(["http://localhost:3000/cb", "http://127.0.0.1:8080/cb", "http://[::1]:8080/cb", "https://claude.ai/cb", "https://claude.ai:8443/x"])(
    "allows %s", (u) => expect(isAllowedRedirectUri(u)).toBe(true),
  );

  it.each([
    "http://example.com/cb", "http://claude.ai/cb", "https://evil.example.com/cb",
    "myapp://callback", "cursor://anysphere.cursor/cb", "javascript:alert(1)", "data:text/html,x", "not a url",
  ])("rejects %s", (u) => expect(isAllowedRedirectUri(u)).toBe(false));
});
