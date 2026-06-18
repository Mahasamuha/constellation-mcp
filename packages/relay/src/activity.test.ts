import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// vi.hoisted runs before mock factories, making the log spy available inside them.
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@constellation/shared", () => ({
  createLogger: () => mockLog,
}));

vi.mock("./config.js", () => ({
  config: {
    activityLog: {
      maxEntriesPerUser: 1000,
      sinks: {
        postgres: true,
        stdout: false,
        webhookUrl: null as string | null,
      },
    },
  },
}));

vi.mock("./db.js", () => ({
  prisma: {
    activityLog: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));

import {
  logEvent,
  registerActivitySink,
  clearActivitySinks,
  initActivitySinks,
  pruneActivityLog,
  type ActivityEvent,
} from "./activity.js";
import { prisma } from "./db.js";
import { config } from "./config.js";

const db = prisma as unknown as {
  activityLog: { create: ReturnType<typeof vi.fn> };
  $executeRaw: ReturnType<typeof vi.fn>;
};

const sinkCfg = config.activityLog.sinks as {
  postgres: boolean;
  stdout: boolean;
  webhookUrl: string | null;
};

const event: ActivityEvent = {
  userId: "user-1",
  eventType: "tool_call",
  host: "home-server",
  tool: "read_file",
  share: "projects",
  requestId: "req-abc123",
  durationMs: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearActivitySinks();
  sinkCfg.postgres = true;
  sinkCfg.stdout = false;
  sinkCfg.webhookUrl = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Sink registry
// ---------------------------------------------------------------------------

describe("sink registry", () => {
  it("does not throw when no sinks are registered", () => {
    expect(() => logEvent(event)).not.toThrow();
  });

  it("delivers the event to a registered sink", () => {
    const sink = vi.fn();
    registerActivitySink(sink);
    logEvent(event);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("delivers the event to every registered sink", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerActivitySink(a);
    registerActivitySink(b);
    logEvent(event);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("does not throw when a sink throws", () => {
    registerActivitySink(() => { throw new Error("boom"); });
    expect(() => logEvent(event)).not.toThrow();
  });

  it("continues delivering to remaining sinks after one throws", () => {
    const after = vi.fn();
    registerActivitySink(() => { throw new Error("boom"); });
    registerActivitySink(after);
    logEvent(event);
    expect(after).toHaveBeenCalledWith(event);
  });

  it("logs a warning when a sink throws", () => {
    const err = new Error("sink error");
    registerActivitySink(() => { throw err; });
    logEvent(event);
    expect(mockLog.warn).toHaveBeenCalledWith({ err }, "Activity sink threw synchronously");
  });
});

// ---------------------------------------------------------------------------
// initActivitySinks — postgres
// ---------------------------------------------------------------------------

describe("initActivitySinks / postgres sink", () => {
  it("registers the postgres sink and writes events to prisma", async () => {
    sinkCfg.postgres = true;
    initActivitySinks();
    logEvent(event);
    await vi.waitFor(() => expect(db.activityLog.create).toHaveBeenCalledWith({ data: event }));
  });

  it("does not register the postgres sink when disabled", async () => {
    sinkCfg.postgres = false;
    initActivitySinks();
    logEvent(event);
    await Promise.resolve();
    expect(db.activityLog.create).not.toHaveBeenCalled();
  });

  it("logs a warning when prisma.activityLog.create rejects", async () => {
    sinkCfg.postgres = true;
    const err = new Error("db failure");
    db.activityLog.create.mockRejectedValue(err);
    initActivitySinks();
    logEvent(event);
    await vi.waitFor(() =>
      expect(mockLog.warn).toHaveBeenCalledWith({ err }, "Failed to write activity log entry")
    );
  });

  it("writes events with a null userId — e.g. hub connect/disconnect", async () => {
    sinkCfg.postgres = true;
    initActivitySinks();
    const hubEvent: ActivityEvent = { userId: null, eventType: "executor_connect", host: "nas" };
    logEvent(hubEvent);
    await vi.waitFor(() => expect(db.activityLog.create).toHaveBeenCalledWith({ data: hubEvent }));
  });
});

// ---------------------------------------------------------------------------
// initActivitySinks — stdout sink
// ---------------------------------------------------------------------------

describe("initActivitySinks / stdout sink", () => {
  it("registers the stdout sink and writes NDJSON", () => {
    sinkCfg.stdout = true;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    initActivitySinks();
    logEvent(event);
    expect(write).toHaveBeenCalledWith(JSON.stringify(event) + "\n");
  });

  it("does not register the stdout sink when disabled", () => {
    sinkCfg.stdout = false;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    initActivitySinks();
    logEvent(event);
    expect(write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// initActivitySinks — webhook sink
// ---------------------------------------------------------------------------

describe("initActivitySinks / webhook sink", () => {
  it("registers the webhook sink and POSTs each event", async () => {
    const url = "https://hooks.example.com/activity";
    sinkCfg.webhookUrl = url;
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    initActivitySinks();
    logEvent(event);
    await vi.waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      })
    );
  });

  it("does not register the webhook sink when webhookUrl is null", async () => {
    sinkCfg.webhookUrl = null;
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    initActivitySinks();
    logEvent(event);
    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("logs a warning when fetch rejects", async () => {
    const url = "https://hooks.example.com/activity";
    sinkCfg.webhookUrl = url;
    const err = new Error("network error");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    initActivitySinks();
    logEvent(event);
    await vi.waitFor(() =>
      expect(mockLog.warn).toHaveBeenCalledWith({ err, url }, "Activity webhook sink failed")
    );
  });
});

// ---------------------------------------------------------------------------
// initActivitySinks — multiple sinks
// ---------------------------------------------------------------------------

describe("initActivitySinks / multiple sinks", () => {
  it("delivers each event to all enabled sinks", async () => {
    sinkCfg.postgres = true;
    sinkCfg.stdout = true;
    sinkCfg.webhookUrl = "https://hooks.example.com/activity";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    initActivitySinks();
    logEvent(event);
    await vi.waitFor(() => {
      expect(db.activityLog.create).toHaveBeenCalled();
      expect(write).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// pruneActivityLog
// ---------------------------------------------------------------------------

describe("pruneActivityLog", () => {
  it("executes the prune query", async () => {
    await pruneActivityLog();
    expect(db.$executeRaw).toHaveBeenCalled();
  });

  it("logs when rows are deleted", async () => {
    db.$executeRaw.mockResolvedValue(7);
    await pruneActivityLog();
    expect(mockLog.info).toHaveBeenCalledWith({ deleted: 7 }, "Pruned activity log entries");
  });

  it("does not log when no rows are deleted", async () => {
    db.$executeRaw.mockResolvedValue(0);
    await pruneActivityLog();
    expect(mockLog.info).not.toHaveBeenCalled();
  });
});
