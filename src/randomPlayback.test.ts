import { afterEach, expect, it, vi } from "vitest";
import { createRandomPlayback, nearestLoopEnd, type RandomSwitchOptions } from "./randomPlayback";
import type { PlayerStatus } from "./tauri";

afterEach(() => vi.useRealTimers());

function setup(action: (request?: RandomSwitchOptions) => Promise<boolean | void>) {
  const onRemaining = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const playback = createRandomPlayback({ action, onRemaining, onSuccess, onError });
  return { ...playback, onRemaining, onSuccess, onError };
}

const playing = (length: number, changes: Partial<PlayerStatus> = {}): PlayerStatus => ({
  loaded: true, playing: true, position_ms: 0, loop_start_ms: 0, loop_end_ms: length,
  loop_enabled: true, pitch_lock: false, speed_pct: 100, generation: 1, path: "first", ...changes,
} as PlayerStatus);

it("chooses the nearest loop ending, including an earlier lap and earlier ties", () => {
  expect(nearestLoopEnd(playing(59_000), 120_000)?.delayMs).toBe(118_000);
  expect(nearestLoopEnd(playing(41_000), 120_000)?.delayMs).toBe(123_000);
  expect(nearestLoopEnd(playing(70_000), 120_000)?.delayMs).toBe(140_000);
  expect(nearestLoopEnd(playing(80_000), 120_000)?.delayMs).toBe(80_000);
  expect(nearestLoopEnd(playing(300_000), 120_000)?.delayMs).toBe(300_000);
});

it("uses the current practice region/position and effective pitch speed", () => {
  expect(nearestLoopEnd(playing(59_000, { speed_pct: 200 }), 120_000)?.delayMs).toBe(118_000);
  expect(nearestLoopEnd(playing(59_000, { position_ms: 30_000 }), 120_000)?.delayMs).toBe(147_000);
  expect(nearestLoopEnd(playing(69_000, { loop_start_ms: 10_000, position_ms: 10_000 }), 120_000)?.delayMs).toBe(118_000);
  // Pitch-lock status already describes the stretched PCM duration.
  expect(nearestLoopEnd(playing(29_500, { speed_pct: 200, pitch_lock: true }), 120_000)?.delayMs).toBe(118_000);
});

it("prepares a 59-second loop change before 1:58 and delegates the exact endpoint to native playback", async () => {
  vi.useFakeTimers();
  const action = vi.fn(() => new Promise<void>(() => {}));
  const playback = setup(action);
  playback.updatePlayback(playing(59_000));
  playback.configure(120_000);
  expect(playback.onRemaining).toHaveBeenLastCalledWith(118);
  await vi.advanceTimersByTimeAsync(116_999);
  expect(action).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ atLoopEnd: true }));
  expect(playback.onRemaining).toHaveBeenLastCalledWith(1);
  playback.configure(null);
});

it("manual Random supersedes a prepared timed switch without waiting for the lap", async () => {
  vi.useFakeTimers();
  let queued: RandomSwitchOptions | undefined;
  const action = vi.fn((request?: RandomSwitchOptions) => {
    if (!request?.atLoopEnd) return Promise.resolve();
    queued = request;
    return new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve()));
  });
  const playback = setup(action);
  playback.updatePlayback(playing(59_000));
  playback.configure(120_000);
  await vi.advanceTimersByTimeAsync(117_000);
  await playback.trigger();
  expect(queued?.signal?.aborted).toBe(true);
  expect(action).toHaveBeenCalledTimes(2);
  expect(action).toHaveBeenLastCalledWith(undefined);
  playback.configure(null);
});

it("pauses the interval clock and does not restart it on position polling", async () => {
  vi.useFakeTimers();
  const action = vi.fn(() => new Promise<void>(() => {}));
  const playback = setup(action);
  playback.updatePlayback(playing(59_000));
  playback.configure(120_000);
  await vi.advanceTimersByTimeAsync(30_000);
  playback.updatePlayback(playing(59_000, { position_ms: 30_000, playing: false }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(action).not.toHaveBeenCalled();
  playback.updatePlayback(playing(59_000, { position_ms: 30_000 }));
  await vi.advanceTimersByTimeAsync(30_000);
  playback.updatePlayback(playing(59_000, { position_ms: 1000 }));
  await vi.advanceTimersByTimeAsync(56_999);
  expect(action).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(action).toHaveBeenCalledOnce();
  playback.configure(null);
});

it("replans the nearest ending after a speed change without resetting the interval", async () => {
  vi.useFakeTimers();
  const action = vi.fn(() => new Promise<void>(() => {}));
  const playback = setup(action);
  playback.updatePlayback(playing(70_000));
  playback.configure(120_000);
  await vi.advanceTimersByTimeAsync(30_000);
  playback.updatePlayback(playing(70_000, { position_ms: 30_000, speed_pct: 200 }));
  expect(playback.onRemaining).toHaveBeenLastCalledWith(90);
  await vi.advanceTimersByTimeAsync(88_999);
  expect(action).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(action).toHaveBeenCalledOnce();
  playback.configure(null);
});

it("disabling Random aborts an armed switch and schedules no replacement", async () => {
  vi.useFakeTimers();
  let queued: RandomSwitchOptions | undefined;
  const action = vi.fn((request?: RandomSwitchOptions) => {
    queued = request;
    return new Promise<void>((resolve) => request?.signal?.addEventListener("abort", () => resolve()));
  });
  const playback = setup(action);
  playback.updatePlayback(playing(59_000));
  playback.configure(120_000);
  await vi.advanceTimersByTimeAsync(117_000);
  playback.configure(null);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(queued?.signal?.aborted).toBe(true);
  expect(action).toHaveBeenCalledOnce();
  expect(playback.onRemaining).toHaveBeenLastCalledWith(null);
  expect(vi.getTimerCount()).toBe(0);
});

it("a pause that cancels an armed native request preserves the original target interval", async () => {
  vi.useFakeTimers();
  let cancel!: (changed: boolean) => void;
  const action = vi.fn(() => new Promise<boolean>((resolve) => { cancel = resolve; }));
  const playback = setup(action);
  playback.updatePlayback(playing(59_000));
  playback.configure(120_000);
  await vi.advanceTimersByTimeAsync(117_000);
  playback.updatePlayback(playing(59_000, { position_ms: 58_000, playing: false }));
  cancel(false);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(action).toHaveBeenCalledOnce();
  playback.updatePlayback(playing(59_000, { position_ms: 58_000 }));
  await vi.advanceTimersByTimeAsync(0);
  // The desired ending is still just one second away, not a fresh two minutes.
  expect(action).toHaveBeenCalledTimes(2);
  playback.configure(null);
});

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
