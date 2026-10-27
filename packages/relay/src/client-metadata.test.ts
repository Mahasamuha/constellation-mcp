import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientMetadata, clientMetadataRouter } from "./client-metadata.js";

const RELAY = "https://relay.example.com";
const KINDS = ["cli", "node", "hub"] as const;

// The rules asterism's clients/cimd.ts enforces on a fetched document (isCanonicalClientIdUrl
// and validateDocument), restated here so a document that asterism would reject fails this test.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function isCanonicalClientIdUrl(id: string): boolean {
  if (id.length > 2000) return false;
  const url = new URL(id);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && !id.includes("#")
    && !url.hostname.endsWith(".") && url.pathname !== "/" && url.href === id;
}

describe("client metadata documents", () => {
  it.each(KINDS)("%s passes asterism's CIMD validation", (kind) => {
    const url = `${RELAY}/clients/${kind}.json`;
    const doc = JSON.parse(JSON.stringify(clientMetadata(RELAY, kind))) as Record<string, unknown>;

    expect(isCanonicalClientIdUrl(url)).toBe(true);
    expect(doc["client_id"]).toBe(url);
    const name = doc["client_name"] as string;
    expect(name.trim().length).toBeGreaterThan(0);
    expect(name.trim().length).toBeLessThanOrEqual(200);
    expect(UNSAFE_TEXT.test(name)).toBe(false);
    expect("client_secret" in doc).toBe(false);
    expect(doc["response_types"]).toContain("code");
    expect(doc["grant_types"]).toEqual(["authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]);
    expect(doc["token_endpoint_auth_method"]).toBe("none");
    // http is only allowed on loopback; no fragment.
    const redirects = doc["redirect_uris"] as string[];
    expect(redirects).toEqual(["http://127.0.0.1/callback"]);
    for (const r of redirects) {
      const u = new URL(r);
      expect(u.hash).toBe("");
      expect(u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)).toBe(true);
    }
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(5 * 1024);
  });

  it("gives each client a distinct id and name", () => {
    const docs = KINDS.map((k) => clientMetadata(RELAY, k));
    expect(new Set(docs.map((d) => d.client_id)).size).toBe(3);
    expect(new Set(docs.map((d) => d.client_name)).size).toBe(3);
  });
});

describe("clientMetadataRouter", () => {
  const original = process.env["RELAY_URL"];
  beforeEach(() => { process.env["RELAY_URL"] = RELAY; });
  afterEach(() => {
    if (original === undefined) delete process.env["RELAY_URL"]; else process.env["RELAY_URL"] = original;
  });

  it.each(KINDS)("serves /clients/%s.json as cacheable JSON without redirecting", (kind) => {
    const layer = (clientMetadataRouter as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown) => void }> } }>;
    }).stack.find((l) => l.route?.path === `/clients/${kind}.json`);
    expect(layer).toBeDefined();

    const headers: Record<string, string> = {};
    let body: unknown;
    let redirected = false;
    const res = {
      set(k: string, v: string) { headers[k] = v; return this; },
      json(b: unknown) { body = b; return this; },
      redirect() { redirected = true; },
    };
    layer!.route!.stack[0]!.handle({}, res);

    expect(redirected).toBe(false);
    expect(headers["Cache-Control"]).toBe("public, max-age=3600");
    expect(body).toEqual(clientMetadata(RELAY, kind));
  });
});
