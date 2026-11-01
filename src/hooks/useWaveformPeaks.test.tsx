// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { playerWaveformPeaks, type WaveformData } from "../tauri";
import { useWaveformPeaks } from "./useWaveformPeaks";

vi.mock("../tauri", async (original) => ({ ...await original<typeof import("../tauri")>(), playerWaveformPeaks: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const wave = (value: number): WaveformData => ({ peaks: [value], buckets: 1, duration_ms: 1000 });
const state = () => ({
  wrapRef: { current: null }, waveRef: { current: null as WaveformData | null },
  waveTrackIdRef: { current: null as number | null }, wavePathRef: { current: null as string | null },
  setGenerating: vi.fn(), setError: vi.fn(), zoom: 1,
});

it("waits until playback is ready and bounds the requested density", async () => {
  const refs = state();
  vi.mocked(playerWaveformPeaks).mockResolvedValue(wave(1));
  const view = renderHook(({ loading, zoom }) => useWaveformPeaks({ ...refs, loadedPath: "track", loading, trackId: 1, zoom }),
    { initialProps: { loading: true, zoom: 32 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(playerWaveformPeaks).not.toHaveBeenCalled();
  view.rerender({ loading: false, zoom: 32 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  expect(playerWaveformPeaks).toHaveBeenCalledExactlyOnceWith("track", 8192);
  expect(refs.waveTrackIdRef.current).toBe(1);
  expect(refs.wavePathRef.current).toBe("track");
  expect(refs.waveRef.current).toEqual(wave(1));
});

it("does not replace new peaks or report an error when an old request completes late", async () => {
  const refs = state();
  let rejectOld!: (cause: Error) => void;
  vi.mocked(playerWaveformPeaks).mockImplementation((path) => path === "old"
    ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(wave(2)));
  const view = renderHook(({ path, id }) => useWaveformPeaks({ ...refs, loadedPath: path, loading: false, trackId: id }),
    { initialProps: { path: "old", id: 1 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ path: "new", id: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  await act(async () => { rejectOld(new Error("old failure")); });
  expect(refs.waveRef.current).toEqual(wave(2));
  expect(refs.wavePathRef.current).toBe("new");
  expect(refs.waveTrackIdRef.current).toBe(2);
  expect(refs.setError).not.toHaveBeenCalledWith(expect.stringContaining("old failure"));
});

it("cancels a pending decode on unmount", async () => {
  const refs = state();
  const view = renderHook(() => useWaveformPeaks({ ...refs, loadedPath: "track", loading: false, trackId: 1 }));
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(playerWaveformPeaks).not.toHaveBeenCalled();
});

it("does not publish a successful decode from an old track after a switch", async () => {
  const refs = state();
  let finishOld!: (value: WaveformData) => void;
  vi.mocked(playerWaveformPeaks).mockImplementation((path) => path === "old"
    ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(wave(2)));
  const view = renderHook(({ path, id }) => useWaveformPeaks({ ...refs, loadedPath: path, loading: false, trackId: id }),
    { initialProps: { path: "old", id: 1 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ path: "new", id: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  await act(async () => { finishOld(wave(1)); });
  expect(refs.waveRef.current).toEqual(wave(2));
  expect(refs.wavePathRef.current).toBe("new");
  expect(refs.waveTrackIdRef.current).toBe(2);
});

it("reuses zoom resolutions for embedded audio but invalidates them on a new audio generation", async () => {
  const refs = state();
  vi.mocked(playerWaveformPeaks).mockResolvedValue(wave(1));
  const view = renderHook(({ zoom, generation }) => useWaveformPeaks({ ...refs, loadedPath: "embedded:1", loading: false, trackId: 1, zoom, generation }),
    { initialProps: { zoom: 1, generation: 4 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ zoom: 2, generation: 4 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ zoom: 1, generation: 4 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  expect(playerWaveformPeaks).toHaveBeenCalledTimes(2);
  view.rerender({ zoom: 1, generation: 5 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  expect(playerWaveformPeaks).toHaveBeenCalledTimes(3);
});

it("keeps one native request active and skips intermediate zoom requests", async () => {
  const refs = state();
  let finish!: (value: WaveformData) => void;
  vi.mocked(playerWaveformPeaks).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValue(wave(2));
  const view = renderHook(({ zoom }) => useWaveformPeaks({ ...refs, loadedPath: "track", loading: false, trackId: 1, zoom }), { initialProps: { zoom: 1 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ zoom: 2 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender({ zoom: 4 });
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  expect(playerWaveformPeaks).toHaveBeenCalledTimes(1);
  await act(async () => { finish(wave(1)); });
  expect(playerWaveformPeaks).toHaveBeenCalledTimes(2);
  expect(playerWaveformPeaks).toHaveBeenLastCalledWith("track", 4096);
});
