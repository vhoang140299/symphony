import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { scheduleLongTimeout } from "../src/system.js";

test("chunks and cancels timeouts longer than Node supports", async () => {
  const maxTimerDelayMs = 2_147_483_647;
  const callback = vi.fn();
  vi.useFakeTimers();
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

  try {
    scheduleLongTimeout(callback, maxTimerDelayMs + 1_000);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)?.[1], maxTimerDelayMs);
    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    assert.equal(callback.mock.calls.length, 0);
    assert.equal(setTimeoutSpy.mock.calls.at(-1)?.[1], 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(callback.mock.calls.length, 1);

    const cancel = scheduleLongTimeout(callback, maxTimerDelayMs + 1_000);
    await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
    cancel();
    cancel();
    await vi.runAllTimersAsync();
    assert.equal(callback.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    setTimeoutSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
