import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";

vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    ...actual,
    createLogger: () => ({ ...log, child: () => log }),
  };
});

vi.mock("./db.js", () => ({
  prisma: {
    user: { upsert: vi.fn() },
    executor: { findMany: vi.fn() },
    pathShare: { findMany: vi.fn() },
    hubShare: { findMany: vi.fn() },
  },
}));

vi.mock("./router.js", () => ({
  routeToolCall: vi.fn(),
  checkToolRateLimit: vi.fn(() => true),
  resolveShare: vi.fn(),
  pruneRateLimits: vi.fn(),
}));

import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createVerifier } from "@mahasamuha/asterism-verify";
import { prisma } from "./db.js";
import { buildMcpServer, mcpRouter } from "./mcp.js";
import { setVerifierForTests } from "./middleware.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type RegisteredTool = {
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function getTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

const EXPECTED_TOOLS = [
  "list_hosts",
  "list_shares",
  "open_file_browser",
  "list_directory",
  "file_info",
  "find_files",
  "read_file",
  "grep_files",
  "write_file",
  "edit_file",
  "copy",
  "create_directory",
  "delete",
  "move",
];

const READ_ONLY_TOOLS = [
  "list_hosts",
  "list_shares",
  "list_directory",
  "file_info",
  "find_files",
  "read_file",
  "grep_files",
];

const DESTRUCTIVE_TOOLS = ["write_file", "edit_file", "delete"];

describe("buildMcpServer", () => {
  let server: McpServer;
  let tools: Record<string, RegisteredTool>;

  beforeEach(() => {
    server = buildMcpServer();
    tools = getTools(server);
  });

  it("returns a McpServer instance", () => {
    expect(server).toBeInstanceOf(McpServer);
  });

  it("registers all expected tools", () => {
    const registered = Object.keys(tools);
    for (const name of EXPECTED_TOOLS) {
      expect(registered).toContain(name);
    }
  });

  it("registers no unexpected tools", () => {
    const registered = Object.keys(tools);
    expect(registered.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("sets readOnlyHint on read-only tools", () => {
    for (const name of READ_ONLY_TOOLS) {
      expect(tools[name]?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("does not set readOnlyHint on mutating tools", () => {
    const mutating = ["write_file", "edit_file", "copy", "move", "create_directory", "delete"];
    for (const name of mutating) {
      expect(tools[name]?.annotations?.readOnlyHint).not.toBe(true);
    }
  });

  it("sets destructiveHint on destructive tools", () => {
    for (const name of DESTRUCTIVE_TOOLS) {
      expect(tools[name]?.annotations?.destructiveHint).toBe(true);
    }
  });

  it("sets idempotentHint:false on edit_file and delete", () => {
    expect(tools["edit_file"]?.annotations?.idempotentHint).toBe(false);
    expect(tools["delete"]?.annotations?.idempotentHint).toBe(false);
  });

  it("sets idempotentHint:true on write_file and create_directory", () => {
    expect(tools["write_file"]?.annotations?.idempotentHint).toBe(true);
    expect(tools["create_directory"]?.annotations?.idempotentHint).toBe(true);
  });

  it("every tool has a non-empty title and description", () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.title, `${name} missing title`).toBeTruthy();
      expect(tool.description, `${name} missing description`).toBeTruthy();
    }
  });
});

const RELAY = "https://relay.example.com";
const ISSUER = "https://asterism.example.com";
const AUDIENCE = `${RELAY}/mcp`;
const CHALLENGE = `Bearer realm="${AUDIENCE}", resource_metadata="${RELAY}/.well-known/oauth-protected-resource/mcp"`;

describe("POST /mcp bearer authentication", () => {
  const prevRelayUrl = process.env["RELAY_URL"];
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwksServer: Server;
  let appServer: Server;
  let mcpUrl: string;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function sign(over: { iss?: string; aud?: string; scope?: string; claims?: Record<string, unknown> } = {}) {
    return new SignJWT({ client_id: "client-1", scope: over.scope ?? "relay", ...over.claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ: "at+jwt" })
      .setIssuer(over.iss ?? ISSUER)
      .setAudience(over.aud ?? AUDIENCE)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  }

  function call(token: string | null, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
    return fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** The JSON-RPC message from a JSON or single-event SSE response. */
  async function rpc(res: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    const text = await res.text();
    const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "data: {}").slice(5);
    return JSON.parse(data) as { result?: Record<string, unknown> };
  }

  beforeAll(async () => {
    process.env["RELAY_URL"] = RELAY;
    keys = await generateKeyPair("ES256");
    const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    jwksServer = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(jwks));
    });
    const jwksUri = await listen(jwksServer);
    setVerifierForTests(createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri }));

    const app = express();
    app.use(express.json());
    app.use(mcpRouter);
    appServer = createServer(app);
    mcpUrl = `${await listen(appServer)}/mcp`;
  });

  afterAll(() => {
    setVerifierForTests(null);
    appServer.close();
    jwksServer.close();
    if (prevRelayUrl === undefined) delete process.env["RELAY_URL"];
    else process.env["RELAY_URL"] = prevRelayUrl;
  });

  beforeEach(() => {
    vi.mocked(prisma.user.upsert).mockReset().mockResolvedValue({ id: "user-1" } as never);
  });

  it("answers 401 with the resource_metadata challenge when there is no token", async () => {
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("accepts a valid token", async () => {
    const res = await call(await sign());
    expect(res.status).toBe(200);
    const msg = await rpc(res);
    expect(Array.isArray(msg.result?.["tools"])).toBe(true);
    expect(prisma.user.upsert).toHaveBeenCalledWith({ where: { id: "user-1" }, create: { id: "user-1" }, update: {} });
  });

  it("rejects a token with the wrong issuer", async () => {
    const res = await call(await sign({ iss: "https://evil.example.com" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${CHALLENGE}, error="invalid_token"`);
  });

  it("rejects a token with the wrong audience", async () => {
    const res = await call(await sign({ aud: "https://other.example.com/mcp" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("answers 403 insufficient_scope when the token lacks the relay scope", async () => {
    const res = await call(await sign({ scope: "profile" }));
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="relay"');
  });

  it("passes the token's groups to the share permission check", async () => {
    const hubShare = (share: string, group: string) => ({
      share,
      instructions: null,
      executor: { host: "h1" },
      permissionBlob: { default: "none", overrides: [{ group, access: "read-only" }] },
    });
    vi.mocked(prisma.pathShare.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.hubShare.findMany).mockResolvedValue([
      hubShare("for-staff", "staff"),
      hubShare("for-others", "others"),
    ] as never);

    const res = await call(await sign({ claims: { groups: ["staff"] } }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_shares", arguments: {} },
    });
    expect(res.status).toBe(200);
    const msg = await rpc(res);
    const shares = (msg.result?.["structuredContent"] as { shares: Array<{ share: string; access: string }> }).shares;
    expect(shares).toEqual([expect.objectContaining({ share: "for-staff", access: "read-only" })]);
  });
});
