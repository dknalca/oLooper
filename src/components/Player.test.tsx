// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Player from "./Player";
import { libraryGetSeratoMetadata, librarySetSeratoCue, type PlayerStatus, type SeratoMetadata } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryGetSeratoMetadata: vi.fn(), librarySetSeratoCue: vi.fn(),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

const base = {
  trackId: null, audioStorage: "extracted" as const, trackOpenGeneration: 0,
  canRandom: true, canNavigateTracks: false, onPreviousTrack: vi.fn(), onNextTrack: vi.fn(),
  loopEditing: false, onToggleLoopEditing: vi.fn(), onStatusChange: vi.fn(),
};
const metadata: SeratoMetadata = { cues: [{ slot: 1, label: "CUE 1", position_ms: 0 }], loops: [], bpm: null };
const status = (id: number): PlayerStatus => ({
  loaded: true, generation: id, path: `track-${id}`, playing: false,
  position_ms: 100, duration_ms: 1000, loop_start_ms: 0, loop_end_ms: 1000,
  loop_enabled: true, volume_pct: 80, speed_pct: 100, pitch_lock: false,
  pitch_preparing: false, pitch_error: null, loading: false, load_error: null,
  position_frame: 100, loop_start_frame: 0, loop_end_frame: 1000, total_frames: 1000,
  loop_origin: "manual", loop_quality: 1, output_left_level_pct: 0, output_right_level_pct: 0, output_error: null,
});

it("button, timer and MIDI use the latest random action and reset the same clock", async () => {
  vi.useFakeTimers();
  const all = vi.fn().mockResolvedValue(undefined);
  const looper = vi.fn().mockResolvedValue(undefined);
  const view = render(<Player {...base} status={null} onRandomTrack={all} />);
  fireEvent.click(screen.getByText("Random OFF"));
  await act(async () => { fireEvent.click(screen.getByTitle("Next random loop (R)")); });
  expect(all).toHaveBeenCalledTimes(1);
  view.rerender(<Player {...base} status={null} onRandomTrack={looper} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(looper).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event("olooper:random-loop")); });
  expect(looper).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
  expect(looper).toHaveBeenCalledTimes(2);
});

it("ignores a CUE mutation response belonging to a previous track", async () => {
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue(metadata);
  let finish!: (value: SeratoMetadata) => void;
  vi.mocked(librarySetSeratoCue).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const random = vi.fn().mockResolvedValue(undefined);
  const view = render(<Player {...base} trackId={1} status={status(1)} onRandomTrack={random} />);
  await act(async () => {});
  fireEvent.click(screen.getByTitle("Save CUE 2 at the current position"));
  view.rerender(<Player {...base} trackId={2} trackOpenGeneration={1} status={status(2)} onRandomTrack={random} />);
  await act(async () => {});
  await act(async () => { finish({ ...metadata, cues: [...metadata.cues, { slot: 2, label: "Old", position_ms: 500 }] }); });
  expect(screen.queryByTitle("Jump to CUE 2")).toBeNull();
  expect(screen.getByTitle("Save CUE 2 at the current position")).toBeTruthy();
});

it("publishes the canonical BPM source and confidence instead of inventing Serato provenance", async () => {
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue({ ...metadata, bpm: 111, bpm_source: "analyzed", bpm_confidence: 0.2 });
  const receive = vi.fn();
  window.addEventListener("olooper:track-bpm", receive);
  try {
    render(<Player {...base} trackId={1} status={status(1)} onRandomTrack={vi.fn()} />);
    await act(async () => {});
    expect((receive.mock.calls[0][0] as CustomEvent).detail).toEqual({ trackId: 1, bpm: 111, source: "analyzed", confidence: 0.2 });
  } finally { window.removeEventListener("olooper:track-bpm", receive); }
});
