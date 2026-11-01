// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Player from "./Player";
import { libraryGetSeratoMetadata, librarySetSeratoCue, librarySyncSeratoMetadata, playerAutoLoop, playerSeek, playerSetLoopSnapped, playerSetSpeed, playerSetVolume, playerStatus, type AutoLoopResult, type PlayerStatus, type SeratoMetadata } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryGetSeratoMetadata: vi.fn(), librarySetSeratoCue: vi.fn(), librarySyncSeratoMetadata: vi.fn(), playerAutoLoop: vi.fn(), playerSeek: vi.fn(), playerSetLoopSnapped: vi.fn(), playerSetSpeed: vi.fn(), playerSetVolume: vi.fn(), playerStatus: vi.fn(),
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

it("uses a custom Random interval and prevents enabling an invalid one", async () => {
  vi.useFakeTimers();
  const random = vi.fn().mockResolvedValue(undefined);
  render(<Player {...base} status={null} onRandomTrack={random} />);
  fireEvent.change(screen.getByLabelText("Random track interval"), { target: { value: "custom" } });
  const input = screen.getByLabelText("Custom random interval in minutes");
  fireEvent.change(input, { target: { value: "0" } });
  expect((screen.getByRole("button", { name: "Random OFF" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Random OFF" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(random).toHaveBeenCalledOnce();
});

it("removes the Random timer and event listener on unmount", async () => {
  vi.useFakeTimers();
  const random = vi.fn().mockResolvedValue(undefined);
  const view = render(<Player {...base} status={null} onRandomTrack={random} />);
  fireEvent.click(screen.getByText("Random OFF"));
  view.unmount();
  await act(async () => {
    window.dispatchEvent(new Event("olooper:random-loop"));
    await vi.advanceTimersByTimeAsync(180_000);
  });
  expect(random).not.toHaveBeenCalled();
});

it("stops a scrub when playback ownership changes and cleans up on unmount", () => {
  vi.mocked(playerSeek).mockResolvedValue(status(1));
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue(metadata);
  const random = vi.fn();
  const view = render(<Player {...base} trackId={1} status={status(1)} onRandomTrack={random} />);
  const slider = screen.getByRole("slider", { name: "Playback position" });
  vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  fireEvent.mouseDown(slider, { clientX: 20 });
  fireEvent.mouseMove(window, { clientX: 40 });
  expect(vi.mocked(playerSeek).mock.calls.map(([position]) => position)).toEqual([200, 400]);
  view.rerender(<Player {...base} trackId={2} status={status(2)} onRandomTrack={random} />);
  fireEvent.mouseMove(window, { clientX: 60 });
  view.unmount();
  fireEvent.mouseMove(window, { clientX: 80 });
  expect(playerSeek).toHaveBeenCalledTimes(2);
});

it("clamps keyboard seeking and ignores it for a mismatched playback path", async () => {
  vi.mocked(playerSeek).mockResolvedValue(status(1));
  const random = vi.fn();
  const view = render(<Player {...base} status={status(1)} onRandomTrack={random} />);
  const slider = screen.getByRole("slider", { name: "Playback position" });
  await act(async () => {
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "End" });
  });
  expect(vi.mocked(playerSeek).mock.calls.map(([position]) => position)).toEqual([0, 1000]);
  view.rerender(<Player {...base} status={status(1)} playbackPath="other" onRandomTrack={random} />);
  fireEvent.keyDown(slider, { key: "Home" });
  expect(playerSeek).toHaveBeenCalledTimes(2);
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

it("ignores a marker read that finishes after another track opens", async () => {
  let finish!: (value: SeratoMetadata) => void;
  vi.mocked(libraryGetSeratoMetadata).mockImplementation((id) => id === 1
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(metadata));
  const random = vi.fn();
  const view = render(<Player {...base} trackId={1} status={status(1)} onRandomTrack={random} />);
  view.rerender(<Player {...base} trackId={2} trackOpenGeneration={1} status={status(2)} onRandomTrack={random} />);
  await act(async () => {});
  await act(async () => { finish({ ...metadata, cues: [...metadata.cues, { slot: 2, label: "Old", position_ms: 500 }] }); });
  expect(screen.queryByTitle("Jump to CUE 2")).toBeNull();
  expect(screen.getByTitle("Save CUE 2 at the current position")).toBeTruthy();
});

it("rejects embedded CUE writes and invalid shortcuts, and removes the shortcut listener", async () => {
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue(metadata);
  vi.mocked(playerSeek).mockResolvedValue(status(1));
  const view = render(<Player {...base} trackId={1} audioStorage="embedded" status={status(1)} onRandomTrack={vi.fn()} />);
  await act(async () => {});
  const shortcut = (slot: number, clear = false) => window.dispatchEvent(new CustomEvent("olooper:cue-shortcut", { detail: { slot, clear } }));
  await act(async () => { shortcut(2); shortcut(0); shortcut(1.5); shortcut(1, true); });
  expect(librarySetSeratoCue).not.toHaveBeenCalled();
  expect(playerSeek).toHaveBeenCalledExactlyOnceWith(0);
  view.unmount();
  shortcut(1);
  expect(playerSeek).toHaveBeenCalledOnce();
});

it("ignores a late Serato sync failure from a previously opened track", async () => {
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue(metadata);
  let fail!: (error: Error) => void;
  vi.mocked(librarySyncSeratoMetadata).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const random = vi.fn();
  const view = render(<Player {...base} trackId={1} status={status(1)} onRandomTrack={random} />);
  await act(async () => {});
  fireEvent.click(screen.getByTitle("Write CUEs and BPM into this audio file"));
  view.rerender(<Player {...base} trackId={2} status={status(2)} trackOpenGeneration={1} onRandomTrack={random} />);
  await act(async () => {});
  await act(async () => { fail(new Error("old sync")); });
  expect(screen.queryByText(/old sync/)).toBeNull();
  expect((screen.getByTitle("Write CUEs and BPM into this audio file") as HTMLButtonElement).disabled).toBe(false);
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

it("routes volume and pitch controls through the current player status handler", async () => {
  const current = status(1);
  const onStatusChange = vi.fn();
  vi.mocked(playerSetVolume).mockResolvedValue({ ...current, volume_pct: 70 });
  vi.mocked(playerSetSpeed).mockResolvedValue({ ...current, speed_pct: 105 });
  render(<Player {...base} status={current} onStatusChange={onStatusChange} onRandomTrack={vi.fn()} />);
  await act(async () => { fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "70" } }); });
  await act(async () => { fireEvent.click(screen.getByTitle("Faster")); });
  expect(playerSetVolume).toHaveBeenCalledWith(70);
  expect(playerSetSpeed).toHaveBeenCalledWith(105);
  expect(onStatusChange).toHaveBeenCalledTimes(2);
});

it("preserves a focused loop draft during status updates and applies it to the current generation", async () => {
  const current = status(1);
  vi.mocked(playerSetLoopSnapped).mockResolvedValue(current);
  const view = render(<Player {...base} status={current} loopEditing onRandomTrack={vi.fn()} />);
  const start = screen.getByLabelText("Loop start in milliseconds") as HTMLInputElement;
  const end = screen.getByLabelText("Loop end in milliseconds") as HTMLInputElement;
  start.focus();
  fireEvent.change(start, { target: { value: "200" } });
  fireEvent.change(end, { target: { value: "800" } });
  view.rerender(<Player {...base} status={{ ...current, loop_start_ms: 300 }} loopEditing onRandomTrack={vi.fn()} />);
  expect(start.value).toBe("200");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply" })); });
  expect(playerSetLoopSnapped).toHaveBeenCalledWith(200, 1000, 1);
});

it("does not apply an automatic loop analyzed for a previous track", async () => {
  vi.mocked(libraryGetSeratoMetadata).mockResolvedValue(metadata);
  let finish!: (result: AutoLoopResult) => void;
  vi.mocked(playerAutoLoop).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const random = vi.fn();
  const view = render(<Player {...base} trackId={1} status={status(1)} loopEditing onRandomTrack={random} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "AUTO" }));
  view.rerender(<Player {...base} trackId={2} status={status(2)} trackOpenGeneration={1} loopEditing onRandomTrack={random} />);
  await act(async () => { finish({ candidate: { start_frame: 100, end_frame: 800 }, sample_rate: 1000 } as AutoLoopResult); });
  expect(playerSetLoopSnapped).not.toHaveBeenCalled();
  expect(screen.queryByText(/Track changed during analysis/)).toBeNull();
});

it("applies automatic loop frame boundaries using the current generation", async () => {
  const current = status(1);
  vi.mocked(playerAutoLoop).mockResolvedValue({ candidate: { start_frame: 4800, end_frame: 19200 }, sample_rate: 48000 } as AutoLoopResult);
  vi.mocked(playerSetLoopSnapped).mockResolvedValue(current);
  render(<Player {...base} status={current} loopEditing onRandomTrack={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "AUTO" })); });
  expect(playerSetLoopSnapped).toHaveBeenCalledExactlyOnceWith(100, 400, 1);
});

it("keeps polling paused background work through its terminal status, then stops", async () => {
  vi.useFakeTimers();
  const completed = { ...status(1), pitch_error: "stretch failed" };
  vi.mocked(playerStatus).mockResolvedValue(completed);
  const onStatusChange = vi.fn();
  const view = render(<Player {...base} status={{ ...status(1), pitch_preparing: true }} onStatusChange={onStatusChange} onRandomTrack={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(playerStatus).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(completed);
  view.rerender(<Player {...base} status={completed} onStatusChange={onStatusChange} onRandomTrack={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("stretch failed");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(playerStatus).toHaveBeenCalledOnce();
});

it("ignores a shared poll from the previous playback owner and captures the next one", async () => {
  vi.useFakeTimers();
  let finish!: (value: PlayerStatus) => void;
  vi.mocked(playerStatus).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ ...status(2), playing: true });
  const onStatusChange = vi.fn();
  const random = vi.fn();
  const view = render(<Player {...base} status={{ ...status(1), playing: true }} onStatusChange={onStatusChange} onRandomTrack={random} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  view.rerender(<Player {...base} status={{ ...status(2), playing: true }} onStatusChange={onStatusChange} onRandomTrack={random} />);
  await act(async () => { finish({ ...status(1), playing: true }); });
  expect(onStatusChange).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(onStatusChange).toHaveBeenCalledExactlyOnceWith({ ...status(2), playing: true });
});

it("unsubscribes an in-flight shared player poll on unmount", async () => {
  vi.useFakeTimers();
  let finish!: (value: PlayerStatus) => void;
  vi.mocked(playerStatus).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const onStatusChange = vi.fn();
  const view = render(<Player {...base} status={{ ...status(1), loading: true }} onStatusChange={onStatusChange} onRandomTrack={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  view.unmount();
  await act(async () => { finish(status(1)); await vi.advanceTimersByTimeAsync(1000); });
  expect(onStatusChange).not.toHaveBeenCalled();
  expect(playerStatus).toHaveBeenCalledOnce();
});
