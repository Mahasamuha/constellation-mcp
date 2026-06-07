import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@constellation/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@constellation/shared")>();
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    ...actual,
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => t,
    generateToken: () => "test-token",
  };
});

vi.mock("./db.js", () => ({
  prisma: {
    oauthSession: { findUnique: vi.fn() },
    agent: { findMany: vi.fn() },
    pathLabel: { findMany: vi.fn() },
    sharedPathLabel: { findMany: vi.fn() },
  },
}));

vi.mock("./router.js", () => ({
  routeToolCall: vi.fn(),
  resolveLabel: vi.fn(),
  pruneRateLimits: vi.fn(),
}));

import { buildMcpServer } from "./mcp.js";
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
  "list_labels",
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
  "list_labels",
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
