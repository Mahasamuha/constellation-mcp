import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => t,
    generateToken: () => "test-token",
    evaluatePermissionBlob: (blob: { default: string; overrides?: Array<{ oidc_sub: string; access: string }> }, userOidcSub?: string | null) => {
      if (userOidcSub && blob.overrides) {
        const override = blob.overrides.find((o) => o.oidc_sub === userOidcSub);
        if (override) return override.access;
      }
      return blob.default || "none";
    },
  };
});

vi.mock("./config.js", () => ({
  config: {
    rateLimits: {
      toolCallsPerMin: 60,
      expensiveToolsPerMin: 20,
      wsReconnectPerMin: 10,
      oauthPer15Min: 10,
      devicePollPer15Min: 200,
    },
    heartbeat: { intervalMs: 60_000, maxMissed: 3 },
    ws: { maxMessageBytes: 10_485_760 },
    rpcTimeoutMs: 30_000,
    forwardedClaims: [],
    port: 3000,
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    pathShare: { findFirst: vi.fn() },
    hubShare: { findMany: vi.fn().mockResolvedValue([]) },
    relayPathFilter: { findMany: vi.fn().mockResolvedValue([]) },
    executor: { findFirst: vi.fn() },
  },
}));

vi.mock("./hub.js", () => ({
  getConnection: vi.fn(),
  dispatchRpc: vi.fn(),
  rejectExecutorRpcs: vi.fn(),
}));

import { prisma } from "./db.js";
import { getConnection, dispatchRpc } from "./hub.js";
import { routeToolCall, checkToolRateLimit, classifyTool } from "./router.js";
import { config } from "./config.js";

// Typed access to mocked functions
const db = prisma as unknown as {
  pathShare: { findFirst: ReturnType<typeof vi.fn> };
  hubShare: { findMany: ReturnType<typeof vi.fn> };
  relayPathFilter: { findMany: ReturnType<typeof vi.fn> };
  executor: { findFirst: ReturnType<typeof vi.fn> };
};
const mockGetConnection = vi.mocked(getConnection);
const mockDispatchRpc = vi.mocked(dispatchRpc);

// Stable share stub — executor online with no path filters
function stubShare(executorId = "executor-1", executorHost = "home-server") {
  db.pathShare.findFirst.mockResolvedValue({
    reportedPath: "/home/user/projects",
    executor: { id: executorId, host: executorHost, lastHeartbeatAt: new Date() },
  });
  db.relayPathFilter.findMany.mockResolvedValue([]);
  mockGetConnection.mockReturnValue({ ws: {}, executorId } as ReturnType<typeof getConnection>);
  mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });
}

let uidSeq = 0;
const uid = () => `user-${uidSeq++}`;

beforeEach(() => {
  vi.clearAllMocks();
  db.relayPathFilter.findMany.mockResolvedValue([]);
  config.rateLimits.toolCallsPerMin = 60;
  config.rateLimits.expensiveToolsPerMin = 20;
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// checkToolRateLimit/classifyTool are the single enforcement point for tool-call rate
// limiting (router.ts no longer self-checks inside routeToolCall — every caller,
// including mcp.ts's registerTool() wrapper for tools that never reach routeToolCall
// at all, like list_hosts/list_shares, goes through these directly). Tested as plain
// functions rather than through routeToolCall/stubShare, since they need none of that
// machinery.
describe("classifyTool", () => {
  it("classifies known cheap tools as standard", () => {
    for (const tool of [
      "list_hosts", "list_shares", "open_file_browser", "read_file", "write_file",
      "edit_file", "file_info", "copy", "create_directory", "delete", "move",
    ]) {
      expect(classifyTool(tool, {})).toBe("standard");
    }
  });

  it("classifies grep_files and find_files as expensive", () => {
    expect(classifyTool("grep_files", {})).toBe("expensive");
    expect(classifyTool("find_files", {})).toBe("expensive");
  });

  it("treats list_directory as expensive only when recursive", () => {
    expect(classifyTool("list_directory", { recursive: true })).toBe("expensive");
    expect(classifyTool("list_directory", {})).toBe("standard");
    expect(classifyTool("list_directory", { recursive: false })).toBe("standard");
  });

  it("defaults an unclassified tool to expensive — the strict fallback for anything not explicitly listed", () => {
    expect(classifyTool("some_future_tool_nobody_classified_yet", {})).toBe("expensive");
  });
});

describe("checkToolRateLimit", () => {
  it("allows calls within the standard limit", () => {
    config.rateLimits.toolCallsPerMin = 3;
    const u = uid();

    expect(checkToolRateLimit(u, "read_file", {})).toBe(true);
    expect(checkToolRateLimit(u, "read_file", {})).toBe(true);
  });

  it("rejects once the standard limit is exceeded", () => {
    config.rateLimits.toolCallsPerMin = 2;
    const u = uid();

    expect(checkToolRateLimit(u, "read_file", {})).toBe(true);
    expect(checkToolRateLimit(u, "read_file", {})).toBe(true);
    expect(checkToolRateLimit(u, "read_file", {})).toBe(false);
  });

  it("rejects an expensive tool once the stricter expensive limit is exceeded", () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    const u = uid();

    expect(checkToolRateLimit(u, "grep_files", {})).toBe(true);
    expect(checkToolRateLimit(u, "grep_files", {})).toBe(false);
  });

  it("gates an unclassified tool by the expensive bucket, not the lenient standard one", () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    const u = uid();

    expect(checkToolRateLimit(u, "some_future_tool", {})).toBe(true);
    expect(checkToolRateLimit(u, "some_future_tool", {})).toBe(false);
  });

  it("standard and expensive calls from the same user count against independent buckets", () => {
    config.rateLimits.toolCallsPerMin = 1;
    config.rateLimits.expensiveToolsPerMin = 1;
    const u = uid();

    expect(checkToolRateLimit(u, "read_file", {})).toBe(true); // consumes the standard bucket
    expect(checkToolRateLimit(u, "grep_files", {})).toBe(true); // independent expensive bucket
    expect(checkToolRateLimit(u, "grep_files", {})).toBe(false); // expensive bucket now exhausted
  });
});

// ---------------------------------------------------------------------------
// Share and host resolution
// ---------------------------------------------------------------------------

describe("share resolution", () => {
  it("returns share_not_found for unknown share", async () => {
    db.pathShare.findFirst.mockResolvedValue(null);
    db.executor.findFirst.mockResolvedValue(null);

    const result = await routeToolCall(uid(), "read_file", "missing", {});
    expect(result).toMatchObject({ code: "share_not_found" });
  });

  it("returns host_not_found when host filter matches no host", async () => {
    db.pathShare.findFirst.mockResolvedValue(null);
    db.executor.findFirst.mockResolvedValue(null); // host does not exist

    const result = await routeToolCall(uid(), "read_file", "projects", {}, "nonexistent-host");
    expect(result).toMatchObject({ code: "host_not_found" });
  });

  it("returns executor_offline when executor has no active connection", async () => {
    db.pathShare.findFirst.mockResolvedValue({
      reportedPath: "/path",
      executor: { id: "executor-offline", host: "home-server", lastHeartbeatAt: new Date(Date.now() - 10_000) },
    });
    db.relayPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue(undefined);

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ code: "executor_offline" });
  });

  it("dispatches and returns result when executor is online", async () => {
    stubShare();
    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ result: { ok: true } });
  });
});

// ---------------------------------------------------------------------------
// Ambiguous hub share resolution
// ---------------------------------------------------------------------------

function hubShareRow(executorId: string, host: string, access = "read-only") {
  return {
    reportedPath: `/data/${host}`,
    permissionBlob: { default: access },
    executor: { id: executorId, host, lastHeartbeatAt: new Date() },
  };
}

// Hub shares are unique per-executor, not per-user, so the same share name can
// legitimately exist on multiple hubs a user has access to. `hubShare.findMany`
// is mocked to actually respect the `executor.host` filter (rather than
// returning a canned list regardless of args) so these tests exercise the same
// host-scoping logic resolveShare relies on, not just canned responses.
function mockHubSharesByHost(rows: ReturnType<typeof hubShareRow>[]) {
  db.hubShare.findMany.mockImplementation(
    ({ where }: { where: { executor?: { host?: string } } }) =>
      Promise.resolve(where.executor?.host ? rows.filter((r) => r.executor.host === where.executor!.host) : rows)
  );
}

describe("ambiguous hub share resolution", () => {
  it("returns ambiguous when the same hub share is visible on two hosts", async () => {
    db.pathShare.findFirst.mockResolvedValue(null);
    mockHubSharesByHost([hubShareRow("hub-1", "server-a"), hubShareRow("hub-2", "server-b")]);

    const result = await routeToolCall(uid(), "read_file", "docs", {});

    expect(result).toMatchObject({ code: "ambiguous" });
    expect((result as { message: string }).message).toContain("server-a");
    expect((result as { message: string }).message).toContain("server-b");
  });

  it("resolves without ambiguity when host disambiguates", async () => {
    db.pathShare.findFirst.mockResolvedValue(null);
    mockHubSharesByHost([hubShareRow("hub-1", "server-a"), hubShareRow("hub-2", "server-b")]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "hub-1" } as ReturnType<typeof getConnection>);
    mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });

    const result = await routeToolCall(uid(), "read_file", "docs", {}, "server-a");

    expect(result).toMatchObject({ result: { ok: true } });
  });

  it("excludes hosts the user has no access to from the ambiguity check", async () => {
    db.pathShare.findFirst.mockResolvedValue(null);
    mockHubSharesByHost([hubShareRow("hub-1", "server-a", "none"), hubShareRow("hub-2", "server-b", "read-only")]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "hub-2" } as ReturnType<typeof getConnection>);
    mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });

    const result = await routeToolCall(uid(), "read_file", "docs", {});

    expect(result).toMatchObject({ result: { ok: true } });
  });
});

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

describe("path filtering", () => {
  it("returns path_filtered when a glob filter blocks the path", async () => {
    db.pathShare.findFirst.mockResolvedValue({
      reportedPath: "/home/user/projects",
      executor: { id: "executor-1", host: "home-server", lastHeartbeatAt: new Date() },
    });
    db.relayPathFilter.findMany.mockResolvedValue([
      { patternType: "glob", pattern: "**/secrets/**" },
    ]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "executor-1" } as ReturnType<typeof getConnection>);

    const result = await routeToolCall(uid(), "read_file", "projects", {
      relative_path: "secrets/creds.txt",
    });

    expect(result).toMatchObject({
      code: "path_filtered",
      message: "Path blocked by relay filter: projects/secrets/creds.txt",
    });
    expect((result as { message: string }).message).not.toContain("/home/user/projects");
  });

  it("returns path_filtered when a regex filter blocks the path", async () => {
    db.pathShare.findFirst.mockResolvedValue({
      reportedPath: "/home/user/projects",
      executor: { id: "executor-1", host: "home-server", lastHeartbeatAt: new Date() },
    });
    db.relayPathFilter.findMany.mockResolvedValue([
      { patternType: "regex", pattern: "\\.env$" },
    ]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "executor-1" } as ReturnType<typeof getConnection>);

    const result = await routeToolCall(uid(), "read_file", "projects", {
      relative_path: ".env",
    });

    expect(result).toMatchObject({ code: "path_filtered" });
  });
});

// ---------------------------------------------------------------------------
// Cross-host copy / move
// ---------------------------------------------------------------------------

describe("cross-host routing", () => {
  it("returns cross_host when dst_share is on a different executor", async () => {
    db.pathShare.findFirst
      .mockResolvedValueOnce({
        reportedPath: "/src",
        executor: { id: "executor-1", host: "server-a", lastHeartbeatAt: new Date() },
      })
      .mockResolvedValueOnce({
        reportedPath: "/dst",
        executor: { id: "executor-2", host: "server-b", lastHeartbeatAt: new Date() },
      });
    db.relayPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "executor-1" } as ReturnType<typeof getConnection>);

    const result = await routeToolCall(uid(), "copy", "src-share", {
      src_relative_path: "file.txt",
      dst_relative_path: "file.txt",
      dst_share: "dst-share",
    });

    expect(result).toMatchObject({ code: "cross_host" });
  });

  it("allows copy within the same executor", async () => {
    db.pathShare.findFirst.mockResolvedValue({
      reportedPath: "/data",
      executor: { id: "executor-1", host: "server-a", lastHeartbeatAt: new Date() },
    });
    db.relayPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "executor-1" } as ReturnType<typeof getConnection>);
    mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });

    const result = await routeToolCall(uid(), "copy", "src-share", {
      src_relative_path: "a.txt",
      dst_relative_path: "b.txt",
      dst_share: "dst-share",
    });

    expect((result as { code?: string }).code).not.toBe("cross_host");
  });

  it("scopes destination hub-share resolution to the source's resolved host", async () => {
    // Source resolves to a personal share on server-a; "dst-share" is not a
    // personal share, but exists as a hub share on both server-a and server-b.
    // Without scoping the dst lookup to server-a, this would resolve as
    // "ambiguous" (or, prior to that fix, arbitrarily match server-b).
    db.pathShare.findFirst
      .mockResolvedValueOnce({
        reportedPath: "/src",
        executor: { id: "executor-1", host: "server-a", lastHeartbeatAt: new Date() },
      })
      .mockResolvedValueOnce(null);
    mockHubSharesByHost([hubShareRow("executor-1", "server-a", "read-write"), hubShareRow("executor-2", "server-b", "read-write")]);
    db.relayPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue({ ws: {}, executorId: "executor-1" } as ReturnType<typeof getConnection>);
    mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });

    const result = await routeToolCall(uid(), "copy", "src-share", {
      src_relative_path: "a.txt",
      dst_relative_path: "b.txt",
      dst_share: "dst-share",
    });

    expect(result).toMatchObject({ result: { ok: true } });
  });
});

// ---------------------------------------------------------------------------
// RPC timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("returns timeout when dispatchRpc throws a timeout error", async () => {
    stubShare();
    mockDispatchRpc.mockRejectedValue(new Error("timeout"));

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ code: "timeout" });
  });

  it("rethrows non-timeout errors", async () => {
    stubShare();
    mockDispatchRpc.mockRejectedValue(new Error("unexpected failure"));

    await expect(routeToolCall(uid(), "read_file", "projects", {})).rejects.toThrow(
      "unexpected failure"
    );
  });
});

// An executor (a user's own node, or an admin's hub) is a separate process this relay
// doesn't control. These lock in that its RPC error fields are cleaned at the single
// point they're received, regardless of what the executor actually sent.
describe("executor error sanitization", () => {
  it("strips control characters (incl. ANSI escapes and newlines) from message/code/path", async () => {
    stubShare();
    mockDispatchRpc.mockResolvedValue({
      request_id: "",
      error: {
        message: "line one\nline two\x1b[31mred\x1b[0m",
        code: "DEST_EXISTS\n[fake]",
        path: "a/b\x00c",
      },
    });

    const result = await routeToolCall(uid(), "copy", "projects", {});
    expect(result).toMatchObject({
      error: {
        message: "line oneline two[31mred[0m",
        code: "DEST_EXISTS[fake]",
        path: "a/bc",
      },
    });
  });

  it("caps an oversized field instead of passing it through in full", async () => {
    stubShare();
    mockDispatchRpc.mockResolvedValue({
      request_id: "",
      error: { message: "x".repeat(1000) },
    });

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    const message = (result as { error: { message: string } }).error.message;
    expect(message.length).toBe(501); // 500 chars + the truncation marker
    expect(message.endsWith("…")).toBe(true);
  });

  it("tolerates a non-string message instead of throwing", async () => {
    stubShare();
    mockDispatchRpc.mockResolvedValue({
      request_id: "",
      error: { message: 12345 as unknown as string },
    });

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ error: { message: "12345" } });
  });
});
