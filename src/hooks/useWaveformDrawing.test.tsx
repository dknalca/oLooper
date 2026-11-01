// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWaveformDrawing } from "./useWaveformDrawing";
import { renderWaveform } from "../waveformRender";
import type { PlayerStatus, SeratoCue, WaveformData } from "../tauri";

vi.mock("../waveformRender", () => ({ renderWaveform: vi.fn() }));
const frames = new Map<number, FrameRequestCallback>();
let next = 0;
beforeEach(() => {
  frames.clear(); next = 0;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const tick = (now: number) => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now)); });
const refs = () => ({
  canvasRef: { current: { clientWidth: 100, clientHeight: 40 } as HTMLCanvasElement },
  statusRef: { current: { path: "track", generation: 1, loaded: true, loading: false, playing: false, position_ms: 500, speed_pct: 200, pitch_lock: true } as PlayerStatus },
  waveRef: { current: { peaks: [0.5], buckets: 1, duration_ms: 1000 } as WaveformData },
  waveTrackIdRef: { current: 1 }, wavePathRef: { current: "track" }, trackIdRef: { current: 1 },
  cuesRef: { current: [] as SeratoCue[] }, zoomRef: { current: 1 },
  previewRef: { current: null as { start: number; end: number } | null }, loopEditingRef: { current: false },
});

it("paints once when paused and redraws when CUEs change", () => {
  const state = refs();
  const view = renderHook(() => useWaveformDrawing(state));
  tick(0);
  expect(renderWaveform).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  state.cuesRef.current = [{ slot: 2, position_ms: 200, label: "CUE" }];
  act(view.result.current); tick(40);
  expect(renderWaveform).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
});

it("suspends only painting under the cover and resumes with the current status", () => {
  const state = refs(); state.statusRef.current.playing = true;
  const view = renderHook(({ paused }) => useWaveformDrawing({ ...state, paused }), { initialProps: { paused: false } });
  tick(0);
  expect(frames.size).toBe(1);
  view.rerender({ paused: true });
  expect(frames.size).toBe(0);
  state.statusRef.current = { ...state.statusRef.current, position_ms: 700 };
  act(view.result.current);
  expect(frames.size).toBe(0);
  view.rerender({ paused: false }); tick(1000);
  expect(vi.mocked(renderWaveform).mock.lastCall?.[3]).toBe(700);
  expect(state.statusRef.current.playing).toBe(true);
});

it("does not include pause time or multiply by pitch speed when pitch lock is active", () => {
  const state = refs();
  const view = renderHook(() => useWaveformDrawing(state));
  tick(0);
  state.statusRef.current = { ...state.statusRef.current, playing: true };
  act(view.result.current); tick(10_000); tick(10_100);
  expect(vi.mocked(renderWaveform).mock.lastCall?.[3]).toBe(600);
});
