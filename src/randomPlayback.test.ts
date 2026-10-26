import { afterEach, expect, it, vi } from "vitest";
import { createRandomPlayback } from "./randomPlayback";

afterEach(() => vi.useRealTimers());

function setup(action: () => Promise<void>) {
  const onRemaining = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const playback = createRandomPlayback({ action, onRemaining, onSuccess, onError });
  return { ...playback, onRemaining, onSuccess, onError };
}

it("manual and timed changes call the same latest random action", async () => {
  vi.useFakeTimers();
  const all = vi.fn().mockResolvedValue(undefined);
  const looper = vi.fn().mockResolvedValue(undefined);
  let currentAction = all;
  const playback = setup(() => currentAction());
  playback.configure(60_000);
  await playback.trigger();
  expect(all).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  currentAction = looper;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(looper).toHaveBeenCalledTimes(1);
  await playback.trigger();
  expect(looper).toHaveBeenCalledTimes(2);
  expect(playback.onSuccess).toHaveBeenCalledTimes(3);
  playback.configure(null);
});

it("pressing Random restarts the automatic countdown from action completion", async () => {
  vi.useFakeTimers();
  const action = vi.fn().mockResolvedValue(undefined);
  const playback = setup(action);
  playback.configure(60_000);
  await vi.advanceTimersByTimeAsync(50_000);
  await playback.trigger();
  expect(playback.onRemaining).toHaveBeenLastCalledWith(60);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(action).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(action).toHaveBeenCalledTimes(2);
  playback.configure(null);
});

it("coalesces manual clicks while a timed change is still loading", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const playback = setup(action);
  playback.configure(1000);
  await vi.advanceTimersByTimeAsync(1000);
  const manual = playback.trigger();
  expect(playback.trigger()).toBe(manual);
  await vi.advanceTimersByTimeAsync(5000);
  expect(action).toHaveBeenCalledTimes(1);
  finish();
  await manual;
  expect(playback.onRemaining).toHaveBeenLastCalledWith(1);
  playback.configure(null);
});

it("handles failures equally and retries on the next interval", async () => {
  vi.useFakeTimers();
  const error = new Error("missing source");
  const action = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
  const playback = setup(action);
  playback.configure(1000);
  await playback.trigger();
  expect(playback.onError).toHaveBeenCalledWith(error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(playback.onSuccess).toHaveBeenCalledTimes(1);
  playback.configure(null);
});

it("disabling or changing the interval during loading uses the latest configuration", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const playback = setup(action);
  playback.configure(1000);
  const pending = playback.trigger();
  await vi.advanceTimersByTimeAsync(0);
  playback.configure(5000);
  finish();
  await pending;
  expect(playback.onRemaining).toHaveBeenLastCalledWith(5);
  playback.configure(null);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(action).toHaveBeenCalledTimes(1);
  expect(playback.onRemaining).toHaveBeenLastCalledWith(null);
});
