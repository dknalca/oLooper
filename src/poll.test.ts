import { afterEach, expect, it, vi } from "vitest";
import { startPolling } from "./poll";

afterEach(() => vi.useRealTimers());

it("never overlaps slow native requests and stops after an in-flight request", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const stop = startPolling(task, 100);
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
});

it("recovers from transient failures and cancels scheduled polling", async () => {
  vi.useFakeTimers();
  const task = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
  const stop = startPolling(task, 100, false);
  expect(task).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
});
