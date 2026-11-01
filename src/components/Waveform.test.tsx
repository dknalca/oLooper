// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Waveform from "./Waveform";
import { playerSeek, playerSetLoopSnapped, playerWaveformPeaks, type PlayerStatus } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(), playerSeek: vi.fn(), playerSetLoopSnapped: vi.fn(), playerWaveformPeaks: vi.fn(),
}));
const status = { loaded: true, loading: false, path: "track", generation: 7, duration_ms: 1000, position_ms: 500, loop_start_ms: 100, loop_end_ms: 900 } as PlayerStatus;
const props = { refreshKey: 0, status, trackTitle: "Track", trackCover: null, trackId: 1, playbackPath: "track", showCover: false, loopEditing: true, onStatusChange: vi.fn() };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.mocked(playerWaveformPeaks).mockResolvedValue({ peaks: [0.5], duration_ms: 1000, buckets: 1 });
  vi.mocked(playerSeek).mockResolvedValue(status);
  vi.mocked(playerSetLoopSnapped).mockResolvedValue(status);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("seeks only after matching peaks load and applies a dragged boundary to the current generation", async () => {
  const view = render(<Waveform {...props} />);
  const canvas = view.container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = vi.fn(() => true);
  canvas.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(canvas, { button: 0, clientX: 50 });
  expect(playerSeek).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  await act(async () => { fireEvent.pointerDown(canvas, { button: 0, clientX: 50 }); });
  expect(playerSeek).toHaveBeenCalledExactlyOnceWith(500);
  fireEvent.pointerDown(canvas, { button: 0, clientX: 10 });
  fireEvent.pointerMove(canvas, { clientX: 20 });
  await act(async () => { fireEvent.pointerUp(canvas, { clientX: 20 }); });
  expect(playerSetLoopSnapped).toHaveBeenCalledExactlyOnceWith(200, 900, 7);
  expect(canvas.releasePointerCapture).toHaveBeenCalledOnce();
});

it("does not seek using peaks belonging to another selected path", async () => {
  const view = render(<Waveform {...props} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
  view.rerender(<Waveform {...props} playbackPath="other" />);
  fireEvent.pointerDown(view.container.querySelector("canvas")!, { button: 0, clientX: 50 });
  expect(playerSeek).not.toHaveBeenCalled();
});
