import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@constellation/shared", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    createLogger: () => ({ ...log, child: () => log }),
    hashToken: (t: string) => t,
    generateToken: () => "test-token",
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
import { routeToolCall } from "./router.js";
import { config } from "./config.js";

// Typed access to mocked functions
const db = prisma as unknown as {
  pathShare: { findFirst: ReturnType<typeof vi.fn> };
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

describe("rate limiting", () => {
  it("allows calls within the standard limit", async () => {
    config.rateLimits.toolCallsPerMin = 3;
    stubShare();
    const u = uid();

    const results = await Promise.all([
      routeToolCall(u, "read_file", "projects", {}),
      routeToolCall(u, "read_file", "projects", {}),
    ]);

    expect(results.every((r) => !("code" in r && (r as { code: string }).code === "rate_limited"))).toBe(true);
  });

  it("returns rate_limited after exceeding standard limit", async () => {
    config.rateLimits.toolCallsPerMin = 2;
    stubShare();
    const u = uid();

    await routeToolCall(u, "read_file", "projects", {});
    await routeToolCall(u, "read_file", "projects", {});
    const result = await routeToolCall(u, "read_file", "projects", {});

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("returns rate_limited for expensive tool after exceeding expensive limit", async () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    stubShare();
    const u = uid();

    await routeToolCall(u, "grep_files", "projects", {});
    const result = await routeToolCall(u, "grep_files", "projects", {});

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("treats recursive list_directory as expensive", async () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    stubShare();
    const u = uid();

    await routeToolCall(u, "list_directory", "projects", { recursive: true });
    const result = await routeToolCall(u, "list_directory", "projects", { recursive: true });

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("does not rate-limit non-recursive list_directory as expensive", async () => {
    config.rateLimits.expensiveToolsPerMin = 1;
    stubShare();
    const u = uid();

    // Two non-recursive calls should both pass the expensive check
    const r1 = await routeToolCall(u, "list_directory", "projects", { recursive: false });
    const r2 = await routeToolCall(u, "list_directory", "projects", { recursive: false });

    expect((r1 as { code?: string }).code).not.toBe("rate_limited");
    expect((r2 as { code?: string }).code).not.toBe("rate_limited");
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

    expect(result).toMatchObject({ code: "path_filtered" });
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
