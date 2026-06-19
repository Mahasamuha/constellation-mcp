import { describe, it, expect } from "vitest";
import { dispatchPendingRpc, resolvePendingRpc, rejectPendingRpcsForExecutor } from "./registry.js";
import type { RpcResponse } from "@constellation/shared";

describe("resolvePendingRpc", () => {
  it("resolves when the responding executor matches the one the request was dispatched to", async () => {
    const promise = dispatchPendingRpc("req-1", "executor-a", 1000);
    const response: RpcResponse = { request_id: "req-1", result: { ok: true } };

    const result = resolvePendingRpc("req-1", "executor-a", response);

    expect(result).toBe("resolved");
    await expect(promise).resolves.toEqual(response);
  });

  it("does not resolve when a different executor responds for someone else's request", async () => {
    const promise = dispatchPendingRpc("req-2", "executor-a", 1000);
    const spoofedResponse: RpcResponse = { request_id: "req-2", result: { ok: true } };

    const result = resolvePendingRpc("req-2", "executor-b", spoofedResponse);
    expect(result).toBe("owner_mismatch");

    // The legitimate owner can still resolve it afterwards.
    const realResponse: RpcResponse = { request_id: "req-2", result: { ok: "real" } };
    expect(resolvePendingRpc("req-2", "executor-a", realResponse)).toBe("resolved");
    await expect(promise).resolves.toEqual(realResponse);
  });

  it("returns not_found for a request id with no pending entry", () => {
    const result = resolvePendingRpc("nonexistent", "executor-a", { request_id: "nonexistent", result: {} });
    expect(result).toBe("not_found");
  });

  it("returns not_found once a pending request has already been rejected", async () => {
    const promise = dispatchPendingRpc("req-3", "executor-a", 1000);
    rejectPendingRpcsForExecutor("executor-a", new Error("executor_disconnected"));
    await expect(promise).rejects.toThrow("executor_disconnected");

    const result = resolvePendingRpc("req-3", "executor-a", { request_id: "req-3", result: {} });
    expect(result).toBe("not_found");
  });
});
