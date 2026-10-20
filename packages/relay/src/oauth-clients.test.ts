import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return { createLogger: () => ({ ...log, child: () => log }) };
});

vi.mock("./config.js", () => ({
  config: { oauthAllowedRedirectOrigins: ["https://claude.ai"], oauthDynamicClientTtlHours: 24 },
}));

const { prismaMock, safeFetchJson } = vi.hoisted(() => ({
  prismaMock: { oauthClient: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } },
  safeFetchJson: vi.fn(),
}));

vi.mock("./db.js", () => ({ prisma: prismaMock }));
vi.mock("./safe-fetch.js", () => ({
  safeFetchJson,
  SafeFetchError: class SafeFetchError extends Error {},
}));

import { SafeFetchError } from "./safe-fetch.js";
import {
  cacheLifetimeMs,
  InvalidClientError,
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
  parseMetadataDocument,
  pruneUnactivatedDynamicClients,
  pruneUnactivatedMetadataDocumentClients,
  resolveOauthClient,
  DEFAULT_GRANT_TYPES,
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
    ["trailing dot host", "https://app.example.com./client.json", "dot"],
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

  it("drops unsupported grant types", () => {
    expect(parse({ ...valid, grant_types: ["authorization_code", "implicit", "refresh_token", "password"] }).grantTypes)
      .toEqual(["authorization_code", "refresh_token"]);
    expect(DEFAULT_GRANT_TYPES).toEqual(["authorization_code", "refresh_token"]);
  });

  it("rejects grant_types without authorization_code", () => {
    expect(() => parse({ ...valid, grant_types: ["implicit"] })).toThrow("authorization_code");
    expect(() => parse({ ...valid, grant_types: ["refresh_token"] })).toThrow("authorization_code");
    expect(() => parse({ ...valid, grant_types: [] })).toThrow("authorization_code");
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
  it.each(["http://localhost:3000/cb", "http://127.0.0.1:8080/cb", "http://[::1]:8080/cb", "https://claude.ai/cb", "https://claude.ai:443/cb"])(
    "allows %s", (u) => expect(isAllowedRedirectUri(u)).toBe(true),
  );

  it.each([
    "http://example.com/cb", "http://claude.ai/cb", "https://evil.example.com/cb",
    "myapp://callback", "cursor://anysphere.cursor/cb", "javascript:alert(1)", "data:text/html,x", "not a url",
    "https://claude.ai:8443/x", "https://claude.ai/cb#frag", "http://127.0.0.1:8080/cb#frag",
  ])("rejects %s", (u) => expect(isAllowedRedirectUri(u)).toBe(false));
});

describe("isRegisteredRedirectUri", () => {
  it("matches exactly", () => {
    expect(isRegisteredRedirectUri(["https://claude.ai/cb"], "https://claude.ai/cb")).toBe(true);
    expect(isRegisteredRedirectUri(["https://claude.ai/cb"], "https://claude.ai/cb2")).toBe(false);
    expect(isRegisteredRedirectUri(["myapp://cb"], "myapp://cb")).toBe(true);
  });

  it.each(["http://127.0.0.1:9999/cb", "http://127.0.0.1/cb"])("ignores port for 127.0.0.1 (%s)", (u) => {
    expect(isRegisteredRedirectUri(["http://127.0.0.1:8080/cb"], u)).toBe(true);
  });

  it("ignores port for localhost and [::1], and allows a registered URI with no port", () => {
    expect(isRegisteredRedirectUri(["http://localhost:3000/cb"], "http://localhost:4000/cb")).toBe(true);
    expect(isRegisteredRedirectUri(["http://[::1]:3000/cb"], "http://[::1]:4000/cb")).toBe(true);
    expect(isRegisteredRedirectUri(["http://127.0.0.1/cb"], "http://127.0.0.1:5555/cb")).toBe(true);
  });

  it("does not equate different loopback hosts, paths or queries", () => {
    expect(isRegisteredRedirectUri(["http://127.0.0.1:8080/cb"], "http://localhost:8080/cb")).toBe(false);
    expect(isRegisteredRedirectUri(["http://127.0.0.1:8080/cb"], "http://127.0.0.1:8080/other")).toBe(false);
    expect(isRegisteredRedirectUri(["http://127.0.0.1:8080/cb?a=1"], "http://127.0.0.1:9/cb?a=2")).toBe(false);
  });

  it("never ignores the port for non-loopback or https URIs", () => {
    expect(isRegisteredRedirectUri(["https://claude.ai/cb"], "https://claude.ai:8443/cb")).toBe(false);
    expect(isRegisteredRedirectUri(["https://127.0.0.1:8080/cb"], "https://127.0.0.1:9090/cb")).toBe(false);
    expect(isRegisteredRedirectUri(["http://example.com:80/cb"], "http://example.com:81/cb")).toBe(false);
    expect(isRegisteredRedirectUri(["https://claude.ai/cb"], "http://127.0.0.1:1/cb")).toBe(false);
  });

  it("rejects an unparsable requested URI", () => {
    expect(isRegisteredRedirectUri(["http://127.0.0.1/cb"], "not a url")).toBe(false);
  });
});

describe("resolveOauthClient", () => {
  const findUnique = prismaMock.oauthClient.findUnique;
  const upsert = prismaMock.oauthClient.upsert;
  const doc = JSON.stringify({ client_id: ID, client_name: "App", redirect_uris: ["http://127.0.0.1:8080/cb"] });
  const now = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("looks up non-URL ids directly", async () => {
    findUnique.mockResolvedValue({ id: "abc" });
    expect(await resolveOauthClient("abc")).toEqual({ id: "abc" });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "abc" } });
    expect(safeFetchJson).not.toHaveBeenCalled();
  });

  it("rejects an invalid URL before touching the DB", async () => {
    await expect(resolveOauthClient("https://app.example.com")).rejects.toThrow(InvalidClientError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a trailing-dot host", async () => {
    await expect(resolveOauthClient("https://app.example.com./c.json")).rejects.toThrow(InvalidClientError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns an unexpired cached row without fetching", async () => {
    const row = { id: ID, isMetadataDocument: true, metadataExpiresAt: new Date(now.getTime() + 1000) };
    findUnique.mockResolvedValue(row);
    expect(await resolveOauthClient(ID)).toBe(row);
    expect(safeFetchJson).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("re-fetches an expired row and upserts with the new expiry", async () => {
    findUnique.mockResolvedValue({ id: ID, isMetadataDocument: true, metadataExpiresAt: new Date(now.getTime() - 1) });
    safeFetchJson.mockResolvedValue({ body: doc, cacheControl: "max-age=1800" });
    upsert.mockResolvedValue({ id: ID });
    await resolveOauthClient(ID);
    expect(safeFetchJson).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ id: ID });
    expect(arg.update.metadataExpiresAt).toEqual(new Date(now.getTime() + 1800_000));
    expect(arg.create).toMatchObject({ id: ID, isDynamic: false, isMetadataDocument: true, clientSecretHash: null, clientName: "App" });
  });

  it("fetches when there is no cached row", async () => {
    findUnique.mockResolvedValue(null);
    safeFetchJson.mockResolvedValue({ body: doc, cacheControl: undefined });
    upsert.mockResolvedValue({ id: ID });
    await resolveOauthClient(ID);
    expect(upsert.mock.calls[0]![0].update.metadataExpiresAt).toEqual(new Date(now.getTime() + DEFAULT));
  });

  it("returns a generic error for fetch failures without leaking the reason", async () => {
    findUnique.mockResolvedValue(null);
    safeFetchJson.mockRejectedValue(new SafeFetchError("host resolves to a disallowed address", { cause: new Error("x") }));
    const err = await resolveOauthClient(ID).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidClientError);
    expect(err.message).toBe("client metadata document could not be retrieved");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a row that is not a metadata document", async () => {
    findUnique.mockResolvedValue({ id: ID, isMetadataDocument: false });
    await expect(resolveOauthClient(ID)).rejects.toThrow(InvalidClientError);
    expect(safeFetchJson).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("pruning", () => {
  const deleteMany = prismaMock.oauthClient.deleteMany;
  const now = new Date("2026-01-02T00:00:00Z");
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    deleteMany.mockResolvedValue({ count: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("prunes unactivated dynamic clients by createdAt", async () => {
    await pruneUnactivatedDynamicClients();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { isDynamic: true, createdAt: { lt: cutoff }, oauthSessions: { none: {} } },
    });
  });

  it("prunes unactivated metadata document clients by metadataExpiresAt", async () => {
    await pruneUnactivatedMetadataDocumentClients();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { isMetadataDocument: true, metadataExpiresAt: { lt: cutoff }, oauthSessions: { none: {} } },
    });
  });
});
