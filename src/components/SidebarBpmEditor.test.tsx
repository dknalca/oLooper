// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";
import useModalFocus from "../hooks/useModalFocus";
import {
  libraryAnalyzeBpm, libraryList, libraryUpdateMetadata, librarySyncSeratoMetadata,
  playerLoadTrack, playerPlay, type Track, type TempoSuggestion, type PlayerStatus,
} from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryList: vi.fn(), libraryPlaylists: vi.fn().mockResolvedValue([]), libraryLooperOrder: vi.fn().mockResolvedValue([]),
  libraryAnalyzeBpm: vi.fn(), libraryUpdateMetadata: vi.fn(), librarySyncSeratoMetadata: vi.fn(),
  playerPrefetch: vi.fn().mockResolvedValue(true), playerLoadTrack: vi.fn(), playerPlay: vi.fn(),
  playerSetDiagnostics: vi.fn().mockResolvedValue(undefined), libraryMarkPlayed: vi.fn().mockResolvedValue(undefined),
}));

const track = (changes: Partial<Track> = {}): Track => ({
  id: 1, title: "Beat", looper_name: "Custom Loops", file_path: "beat.wav", playback_path: "beat.wav",
  source_type: "custom", source_hash: "beat", source_path: "original.wav", source_sound_id: 0,
  exists: true, audio_storage: "extracted", source_managed: false, codec: "wav",
  sample_rate: 8000, channels: 1, duration_ms: 9600, seek_samples: 0, trimmed_leading: 0,
  bpm: 98, bpm_confidence: 0.2, bpm_source: "analyzed", primary_cue_ms: 0,
  loop_start_ms: 0, loop_end_ms: 9600, loop_enabled: true, loop_start_frame: 0,
  loop_end_frame: 76800, loop_origin: "manual", loop_quality: 1, loop_needs_review: false,
  total_frames: 76800, imported_at: 0, updated_at: 0, favorite: true, tags: "", last_played_at: null,
  ...changes,
});
const suggestion = (changes: Partial<TempoSuggestion> = {}): TempoSuggestion => ({
  track_id: 1, bpm: 100, confidence: 0.3, duration_frames: 76800,
  sample_rate: 8000, assumed_meter: "4/4", bars: 4, ...changes,
});
const props = {
  libraryReady: true, libraryGeneration: 0, refreshKey: 0, activeTrackId: null,
  onLibraryViewChange: vi.fn(),
  onRegisterTrackNavigation: vi.fn(), onRegisterRandomScope: vi.fn(),
  onRegisterMidiLibraryNavigation: vi.fn(), onTrackLoading: vi.fn(), onTrackSelected: vi.fn(),
};
function Fixture({ generation = 0 }) {
  useModalFocus();
  return <Sidebar {...props} libraryGeneration={generation} />;
}
let user: ReturnType<typeof userEvent.setup>;
const input = () => screen.getByRole("spinbutton", { name: /^BPM/ }) as HTMLInputElement;
const open = async (name = "Beat") => {
  await act(async () => {});
  const cell = screen.getByRole("button", { name: `Edit BPM for ${name}` });
  cell.focus();
  await user.dblClick(cell);
};
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  user = userEvent.setup({ delay: null });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  vi.mocked(libraryList).mockResolvedValue([track()]);
  vi.mocked(libraryAnalyzeBpm).mockResolvedValue(suggestion());
  vi.mocked(librarySyncSeratoMetadata).mockResolvedValue(undefined);
  vi.mocked(libraryUpdateMetadata).mockImplementation(async (id, title, bpm, tags, manual) => track({ id, title, bpm, tags, bpm_source: manual ? "manual" : "analyzed", bpm_confidence: manual ? null : 0.2 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("double-clicking BPM focuses its editor without playback and never applies a preview to the draft", async () => {
  render(<Fixture />);
  await open();
  expect(document.activeElement).toBe(input());
  expect(input().value).toBe("98");
  expect(await screen.findByRole("button", { name: "Detected · 100 BPM" })).toBeTruthy();
  expect(libraryAnalyzeBpm).toHaveBeenCalledExactlyOnceWith(1);
  expect(playerLoadTrack).not.toHaveBeenCalled();
  expect(playerPlay).not.toHaveBeenCalled();
  expect(HTMLElement.prototype.setPointerCapture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  expect(libraryUpdateMetadata).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit BPM for Beat" }));
});

it("a pointer single-click only selects; keyboard activation also opens the focused BPM editor", async () => {
  render(<Fixture />);
  await act(async () => {});
  const button = screen.getByRole("button", { name: "Edit BPM for Beat" });
  await user.click(button);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(libraryAnalyzeBpm).not.toHaveBeenCalled();
  button.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(input());
  expect(playerLoadTrack).not.toHaveBeenCalled();
});

it("ratios have a stable base and save only the explicit selected tempo", async () => {
  render(<Fixture />);
  await open();
  await screen.findByRole("button", { name: "Detected · 100 BPM" });
  fireEvent.click(screen.getByRole("button", { name: "Half · 50 BPM" }));
  fireEvent.click(screen.getByRole("button", { name: "Half · 50 BPM" }));
  expect(input().value).toBe("50");
  fireEvent.click(await screen.findByRole("button", { name: "Detected · 100 BPM" }));
  expect(input().value).toBe("100");
  fireEvent.click(screen.getByRole("button", { name: "Double · 200 BPM" }));
  expect(input().value).toBe("200");
  expect(libraryUpdateMetadata).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save metadata" })); });
  expect(libraryUpdateMetadata).toHaveBeenCalledWith(1, "Beat", 200, "", true);
  expect(librarySyncSeratoMetadata).toHaveBeenCalledExactlyOnceWith(1);
});

it("same-value ×1 is manual confirmation, and embedded tracks never sync tags", async () => {
  vi.mocked(libraryList).mockResolvedValue([track({ bpm: 100, audio_storage: "embedded", playback_path: "embedded:1" })]);
  vi.mocked(libraryUpdateMetadata).mockResolvedValue(track({ bpm: 100, audio_storage: "embedded", bpm_source: "manual", bpm_confidence: null }));
  render(<Fixture />);
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Detected · 100 BPM" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save metadata" })); });
  expect(libraryUpdateMetadata).toHaveBeenCalledWith(1, "Beat", 100, "", true);
  expect(librarySyncSeratoMetadata).not.toHaveBeenCalled();
});

it("changing only a title does not apply the suggestion or trigger Serato BPM writes", async () => {
  render(<Fixture />);
  await open();
  fireEvent.change(screen.getByRole("textbox", { name: "Loop title" }), { target: { value: "New title" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save metadata" })); });
  expect(libraryUpdateMetadata).toHaveBeenCalledWith(1, "New title", 98, "", false);
  expect(librarySyncSeratoMetadata).not.toHaveBeenCalled();
});

it("a late preview cannot overwrite a manually entered base", async () => {
  let finish!: (value: TempoSuggestion) => void;
  vi.mocked(libraryAnalyzeBpm).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<Fixture />);
  await open();
  fireEvent.change(input(), { target: { value: "123" } });
  await act(async () => { finish(suggestion()); });
  expect(input().value).toBe("123");
  expect(screen.getByRole("button", { name: "Entered · 123 BPM" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Detected · 100 BPM" })).toBeNull();
});

it("Tap tempo wins over a late preview and establishes its own ratio base", async () => {
  let finish!: (value: TempoSuggestion) => void;
  vi.mocked(libraryAnalyzeBpm).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<Fixture />);
  await open();
  const clock = vi.spyOn(performance, "now");
  for (const time of [0, 500, 1000, 1500]) {
    clock.mockReturnValue(time);
    fireEvent.click(screen.getByRole("button", { name: "Tap tempo" }));
  }
  await act(async () => { finish(suggestion()); });
  expect(input().value).toBe("120");
  expect(screen.getByRole("button", { name: "Tapped · 120 BPM" })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save metadata" })); });
  expect(libraryUpdateMetadata).toHaveBeenCalledWith(1, "Beat", 120, "", true);
});

it("closing and reopening the same track rejects the old session's response", async () => {
  let old!: (value: TempoSuggestion) => void;
  vi.mocked(libraryAnalyzeBpm).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
  render(<Fixture />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await open();
  await act(async () => { old(suggestion({ bpm: 140 })); });
  expect(await screen.findByRole("button", { name: "Detected · 100 BPM" })).toBeTruthy();
  expect(input().value).toBe("98");
});

it("changing the library closes the editor and ignores the old-root preview", async () => {
  let old!: (value: TempoSuggestion) => void;
  vi.mocked(libraryAnalyzeBpm).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
  const view = render(<Fixture />);
  await open();
  view.rerender(<Fixture generation={1} />);
  await act(async () => { old(suggestion()); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(libraryUpdateMetadata).not.toHaveBeenCalled();
});

it.each(["manual", "serato", "analyzed"])("preserves known %s BPMs without automatic preview", async (source) => {
  vi.mocked(libraryList).mockResolvedValue([track({ bpm: 100, bpm_source: source, bpm_confidence: null })]);
  render(<Fixture />);
  await open();
  expect(screen.getByRole("button", { name: "Current · 100 BPM" })).toBeTruthy();
  expect(libraryAnalyzeBpm).not.toHaveBeenCalled();
});

it("missing BPM opens via its placeholder and an analysis failure keeps manual editing available", async () => {
  vi.mocked(libraryList).mockResolvedValue([track({ bpm: null, bpm_confidence: null, bpm_source: null })]);
  vi.mocked(libraryAnalyzeBpm).mockRejectedValueOnce(new Error("missing audio"));
  render(<Fixture />);
  await open();
  expect(input().value).toBe("");
  expect(await screen.findByText(/Tempo analysis failed/)).toBeTruthy();
  fireEvent.change(input(), { target: { value: "160" } });
  expect(screen.getByRole("button", { name: "Half · 80 BPM" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Double · 320 BPM" })).toBeNull();
  expect(playerLoadTrack).not.toHaveBeenCalled();
});

it("double-clicking the title still plays instead of opening BPM metadata", async () => {
  const status = { loaded: true, loading: false, load_error: null, path: "beat.wav" } as PlayerStatus;
  vi.mocked(playerLoadTrack).mockResolvedValue(status);
  vi.mocked(playerPlay).mockResolvedValue(status);
  render(<Fixture />);
  await act(async () => {});
  await user.dblClick(screen.getByText("Beat"));
  expect(playerLoadTrack).toHaveBeenCalledExactlyOnceWith(1);
  expect(playerPlay).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(libraryAnalyzeBpm).not.toHaveBeenCalled();
});

it("a pending or failed save preserves the selected draft and disables ratio controls", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(libraryUpdateMetadata).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<Fixture />);
  await open();
  fireEvent.click(await screen.findByRole("button", { name: "Double · 200 BPM" }));
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
  expect(screen.getByRole("group", { name: "Tempo options" }).hasAttribute("disabled")).toBe(true);
  await act(async () => { fail(new Error("cannot save metadata")); });
  expect(input().value).toBe("200");
  expect(screen.getByRole("alert").textContent).toContain("cannot save metadata");
  expect(screen.getByRole("group", { name: "Tempo options" }).hasAttribute("disabled")).toBe(false);
});
