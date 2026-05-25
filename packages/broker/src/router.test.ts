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
    port: 3000,
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    pathLabel: { findFirst: vi.fn() },
    brokerPathFilter: { findMany: vi.fn().mockResolvedValue([]) },
    agent: { findFirst: vi.fn() },
  },
}));

vi.mock("./hub.js", () => ({
  getConnection: vi.fn(),
  dispatchRpc: vi.fn(),
  rejectAgentRpcs: vi.fn(),
}));

import { prisma } from "./db.js";
import { getConnection, dispatchRpc } from "./hub.js";
import { routeToolCall } from "./router.js";
import { config } from "./config.js";

// Typed access to mocked functions
const db = prisma as unknown as {
  pathLabel: { findFirst: ReturnType<typeof vi.fn> };
  brokerPathFilter: { findMany: ReturnType<typeof vi.fn> };
  agent: { findFirst: ReturnType<typeof vi.fn> };
};
const mockGetConnection = vi.mocked(getConnection);
const mockDispatchRpc = vi.mocked(dispatchRpc);

// Stable label stub — agent online with no path filters
function stubLabel(agentId = "agent-1", agentHost = "home-server") {
  db.pathLabel.findFirst.mockResolvedValue({
    reportedPath: "/home/user/projects",
    agent: { id: agentId, host: agentHost, lastHeartbeatAt: new Date() },
  });
  db.brokerPathFilter.findMany.mockResolvedValue([]);
  mockGetConnection.mockReturnValue({ ws: {}, agentId } as ReturnType<typeof getConnection>);
  mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });
}

let uidSeq = 0;
const uid = () => `user-${uidSeq++}`;

beforeEach(() => {
  vi.clearAllMocks();
  db.brokerPathFilter.findMany.mockResolvedValue([]);
  config.rateLimits.toolCallsPerMin = 60;
  config.rateLimits.expensiveToolsPerMin = 20;
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("allows calls within the standard limit", async () => {
    config.rateLimits.toolCallsPerMin = 3;
    stubLabel();
    const u = uid();

    const results = await Promise.all([
      routeToolCall(u, "read_file", "projects", {}),
      routeToolCall(u, "read_file", "projects", {}),
    ]);

    expect(results.every((r) => !("code" in r && (r as { code: string }).code === "rate_limited"))).toBe(true);
  });

  it("returns rate_limited after exceeding standard limit", async () => {
    config.rateLimits.toolCallsPerMin = 2;
    stubLabel();
    const u = uid();

    await routeToolCall(u, "read_file", "projects", {});
    await routeToolCall(u, "read_file", "projects", {});
    const result = await routeToolCall(u, "read_file", "projects", {});

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("returns rate_limited for expensive tool after exceeding expensive limit", async () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    stubLabel();
    const u = uid();

    await routeToolCall(u, "grep_files", "projects", {});
    const result = await routeToolCall(u, "grep_files", "projects", {});

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("treats recursive list_directory as expensive", async () => {
    config.rateLimits.toolCallsPerMin = 100;
    config.rateLimits.expensiveToolsPerMin = 1;
    stubLabel();
    const u = uid();

    await routeToolCall(u, "list_directory", "projects", { recursive: true });
    const result = await routeToolCall(u, "list_directory", "projects", { recursive: true });

    expect(result).toMatchObject({ code: "rate_limited" });
  });

  it("does not rate-limit non-recursive list_directory as expensive", async () => {
    config.rateLimits.expensiveToolsPerMin = 1;
    stubLabel();
    const u = uid();

    // Two non-recursive calls should both pass the expensive check
    const r1 = await routeToolCall(u, "list_directory", "projects", { recursive: false });
    const r2 = await routeToolCall(u, "list_directory", "projects", { recursive: false });

    expect((r1 as { code?: string }).code).not.toBe("rate_limited");
    expect((r2 as { code?: string }).code).not.toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------
// Label and host resolution
// ---------------------------------------------------------------------------

describe("label resolution", () => {
  it("returns label_not_found for unknown label", async () => {
    db.pathLabel.findFirst.mockResolvedValue(null);
    db.agent.findFirst.mockResolvedValue(null);

    const result = await routeToolCall(uid(), "read_file", "missing", {});
    expect(result).toMatchObject({ code: "label_not_found" });
  });

  it("returns host_not_found when host filter matches no host", async () => {
    db.pathLabel.findFirst.mockResolvedValue(null);
    db.agent.findFirst.mockResolvedValue(null); // host does not exist

    const result = await routeToolCall(uid(), "read_file", "projects", {}, "nonexistent-host");
    expect(result).toMatchObject({ code: "host_not_found" });
  });

  it("returns agent_offline when agent has no active connection", async () => {
    db.pathLabel.findFirst.mockResolvedValue({
      reportedPath: "/path",
      agent: { id: "agent-offline", host: "home-server", lastHeartbeatAt: new Date(Date.now() - 10_000) },
    });
    db.brokerPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue(undefined);

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ code: "agent_offline" });
  });

  it("dispatches and returns result when agent is online", async () => {
    stubLabel();
    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ result: { ok: true } });
  });
});

// ---------------------------------------------------------------------------
// Path filtering
// ---------------------------------------------------------------------------

describe("path filtering", () => {
  it("returns path_filtered when a glob filter blocks the path", async () => {
    db.pathLabel.findFirst.mockResolvedValue({
      reportedPath: "/home/user/projects",
      agent: { id: "agent-1", host: "home-server", lastHeartbeatAt: new Date() },
    });
    db.brokerPathFilter.findMany.mockResolvedValue([
      { patternType: "glob", pattern: "**/secrets/**" },
    ]);
    mockGetConnection.mockReturnValue({ ws: {}, agentId: "agent-1" } as ReturnType<typeof getConnection>);

    const result = await routeToolCall(uid(), "read_file", "projects", {
      relative_path: "secrets/creds.txt",
    });

    expect(result).toMatchObject({ code: "path_filtered" });
  });

  it("returns path_filtered when a regex filter blocks the path", async () => {
    db.pathLabel.findFirst.mockResolvedValue({
      reportedPath: "/home/user/projects",
      agent: { id: "agent-1", host: "home-server", lastHeartbeatAt: new Date() },
    });
    db.brokerPathFilter.findMany.mockResolvedValue([
      { patternType: "regex", pattern: "\\.env$" },
    ]);
    mockGetConnection.mockReturnValue({ ws: {}, agentId: "agent-1" } as ReturnType<typeof getConnection>);

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
  it("returns cross_host when dst_label is on a different agent", async () => {
    db.pathLabel.findFirst
      .mockResolvedValueOnce({
        reportedPath: "/src",
        agent: { id: "agent-1", host: "server-a", lastHeartbeatAt: new Date() },
      })
      .mockResolvedValueOnce({
        reportedPath: "/dst",
        agent: { id: "agent-2", host: "server-b", lastHeartbeatAt: new Date() },
      });
    db.brokerPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue({ ws: {}, agentId: "agent-1" } as ReturnType<typeof getConnection>);

    const result = await routeToolCall(uid(), "copy", "src-label", {
      src_relative_path: "file.txt",
      dst_relative_path: "file.txt",
      dst_label: "dst-label",
    });

    expect(result).toMatchObject({ code: "cross_host" });
  });

  it("allows copy within the same agent", async () => {
    db.pathLabel.findFirst.mockResolvedValue({
      reportedPath: "/data",
      agent: { id: "agent-1", host: "server-a", lastHeartbeatAt: new Date() },
    });
    db.brokerPathFilter.findMany.mockResolvedValue([]);
    mockGetConnection.mockReturnValue({ ws: {}, agentId: "agent-1" } as ReturnType<typeof getConnection>);
    mockDispatchRpc.mockResolvedValue({ request_id: "", result: { ok: true } });

    const result = await routeToolCall(uid(), "copy", "src-label", {
      src_relative_path: "a.txt",
      dst_relative_path: "b.txt",
      dst_label: "dst-label",
    });

    expect((result as { code?: string }).code).not.toBe("cross_host");
  });
});

// ---------------------------------------------------------------------------
// RPC timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("returns timeout when dispatchRpc throws a timeout error", async () => {
    stubLabel();
    mockDispatchRpc.mockRejectedValue(new Error("timeout"));

    const result = await routeToolCall(uid(), "read_file", "projects", {});
    expect(result).toMatchObject({ code: "timeout" });
  });

  it("rethrows non-timeout errors", async () => {
    stubLabel();
    mockDispatchRpc.mockRejectedValue(new Error("unexpected failure"));

    await expect(routeToolCall(uid(), "read_file", "projects", {})).rejects.toThrow(
      "unexpected failure"
    );
  });
});
