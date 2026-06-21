import { describe, it, expect, afterEach, vi } from "vitest";
import { poll } from "./cli-util.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("poll", () => {
  it("returns the first non-null result without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    const result = await poll(fn, 1000, 10000);
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns null once the deadline elapses without a non-null result", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(null);

    // 3 calls at t=0/1000/2000, each followed by a 1000ms sleep; the third sleep
    // lands exactly on the t=3000 deadline, so the post-sleep while-check fails then.
    const resultPromise = poll(fn, 1000, 3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(await resultPromise).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("waits the original interval between calls until setIntervalMs is used", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue(null);

    const resultPromise = poll(fn, 1000, 5000);
    expect(fn).toHaveBeenCalledTimes(1); // the first call happens immediately, before any wait
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000);
    expect(await resultPromise).toBeNull();
  });

  it("applies an interval increase from setIntervalMs to this and all subsequent waits (RFC 8628 slow_down)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async ({ intervalMs, setIntervalMs }) => {
      calls += 1;
      if (calls === 1) setIntervalMs(intervalMs + 5000); // 1000ms -> 6000ms
      return null;
    });

    const resultPromise = poll(fn, 1000, 12001);
    expect(fn).toHaveBeenCalledTimes(1);

    // The bumped 6000ms interval applies to the very next wait, not the original 1000ms.
    await vi.advanceTimersByTimeAsync(5999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // ...and it persists for every wait after that, not just the one right after the bump.
    await vi.advanceTimersByTimeAsync(6000);
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6000);
    expect(await resultPromise).toBeNull();
  });
});
