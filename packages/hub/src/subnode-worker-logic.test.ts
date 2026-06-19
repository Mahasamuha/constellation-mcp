import { describe, it, expect, vi } from "vitest";
import {
  isValidMessage,
  handleRequest,
  type SubnodeRequest,
  type SubnodeResponse,
  type MinimalExecutor,
} from "./subnode-worker-logic.js";

describe("isValidMessage", () => {
  it("accepts a well-formed init message", () => {
    expect(isValidMessage({ type: "init", shares: { docs: "/srv/docs" }, max_file_size_kb: 100 })).toBe(true);
  });

  it("accepts a well-formed request message", () => {
    expect(isValidMessage({ type: "request", request_id: "r1", tool: "read_file", share: "docs", params: {} })).toBe(true);
  });

  it.each([
    ["missing type", { request_id: "r1", tool: "read_file", share: "docs" }],
    ["unknown type", { type: "bogus" }],
    ["null", null],
    ["a string", "request"],
    ["init missing shares", { type: "init", max_file_size_kb: 100 }],
    ["init with non-numeric max_file_size_kb", { type: "init", shares: {}, max_file_size_kb: "100" }],
    ["request missing request_id", { type: "request", tool: "read_file", share: "docs" }],
    ["request missing tool", { type: "request", request_id: "r1", share: "docs" }],
    ["request missing share", { type: "request", request_id: "r1", tool: "read_file" }],
  ])("rejects %s", (_name, msg) => {
    expect(isValidMessage(msg)).toBe(false);
  });
});

describe("handleRequest", () => {
  function makeRequest(overrides: Partial<SubnodeRequest> = {}): SubnodeRequest {
    return { type: "request", request_id: "r1", tool: "read_file", share: "docs", params: {}, ...overrides };
  }

  it("sends a result response when the executor succeeds", async () => {
    const executor: MinimalExecutor = { execute: vi.fn().mockResolvedValue({ content: "file contents" }) };
    const send = vi.fn<(msg: SubnodeResponse) => void>();

    await handleRequest(executor, makeRequest(), send);

    expect(executor.execute).toHaveBeenCalledWith("read_file", "docs", {});
    expect(send).toHaveBeenCalledWith({ type: "response", request_id: "r1", result: "file contents" });
  });

  it("sends an error response when the executor reports a tool error", async () => {
    const executor: MinimalExecutor = {
      execute: vi.fn().mockResolvedValue({ content: { message: "Path rejected" }, isError: true }),
    };
    const send = vi.fn<(msg: SubnodeResponse) => void>();

    await handleRequest(executor, makeRequest(), send);

    expect(send).toHaveBeenCalledWith({ type: "response", request_id: "r1", error: { message: "Path rejected" } });
  });

  it("sends a generic internal-error response, without leaking the original message, if execute() throws", async () => {
    const executor: MinimalExecutor = {
      execute: vi.fn().mockRejectedValue(new Error("ENOENT: /etc/shadow")),
    };
    const send = vi.fn<(msg: SubnodeResponse) => void>();

    await handleRequest(executor, makeRequest(), send);

    expect(send).toHaveBeenCalledWith({ type: "response", request_id: "r1", error: { message: "Internal error" } });
  });

  it("never throws even when execute() rejects", async () => {
    const executor: MinimalExecutor = { execute: vi.fn().mockRejectedValue(new Error("boom")) };
    const send = vi.fn<(msg: SubnodeResponse) => void>();

    await expect(handleRequest(executor, makeRequest(), send)).resolves.toBeUndefined();
  });
});
