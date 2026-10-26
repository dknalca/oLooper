// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";
import { libraryList, libraryPlaylists, playerPrefetch, type Track } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryList: vi.fn(), libraryPlaylists: vi.fn().mockResolvedValue([]), libraryLooperOrder: vi.fn().mockResolvedValue([]),
  playerPrefetch: vi.fn().mockResolvedValue(true),
}));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const track = (id: number, title: string): Track => ({
  id, title, looper_name: "Custom Loops", file_path: title, playback_path: title,
  source_type: "custom", source_hash: title, source_path: title, source_sound_id: 0,
  exists: true, audio_storage: "extracted", source_managed: false, codec: "wav",
  sample_rate: 8000, channels: 1, duration_ms: 1000, seek_samples: 0, trimmed_leading: 0,
  bpm: null, bpm_confidence: null, bpm_source: null, primary_cue_ms: 0,
  loop_start_ms: 0, loop_end_ms: 1000, loop_enabled: true, loop_start_frame: 0,
  loop_end_frame: 8000, loop_origin: "manual", loop_quality: 1, loop_needs_review: false,
  total_frames: 8000, imported_at: 0, updated_at: 0, favorite: true, tags: "", last_played_at: null,
});
const props = {
  libraryReady: true, libraryGeneration: 0, refreshKey: 0, activeTrackId: null,
  onLibraryViewChange: vi.fn(),
  onRegisterTrackNavigation: vi.fn(), onRegisterRandomScope: vi.fn(),
  onRegisterMidiLibraryNavigation: vi.fn(), onTrackLoading: vi.fn(), onTrackSelected: vi.fn(),
};

it("does not repopulate another library with a stale catalog response", async () => {
  let finishOld!: (tracks: Track[]) => void;
  vi.mocked(libraryList).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce([track(1, "New library loop")]);
  const view = render(<Sidebar {...props} />);
  view.rerender(<Sidebar {...props} libraryGeneration={1} refreshKey={1} />);
  await act(async () => {});
  expect(screen.getByText("New library loop")).toBeTruthy();
  await act(async () => { finishOld([track(1, "Old library loop")]); });
  expect(screen.queryByText("Old library loop")).toBeNull();
  expect(screen.getByText("New library loop")).toBeTruthy();
});

it("shows which looper each track comes from in All, Favorites and playlists", async () => {
  vi.mocked(libraryList).mockResolvedValue([
    { ...track(1, "Break"), source_type: "swf", looper_name: "Break Pack", source_hash: "swf-a" },
    { ...track(2, "Fill"), source_type: "swf", looper_name: "Fills", source_hash: "swf-b" },
  ]);
  render(<Sidebar {...props} />);
  await act(async () => {});
  expect(screen.getByText("Looper")).toBeTruthy();
  const rows = Array.from(document.querySelectorAll("[data-library-track-id]"));
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("Break Pack"),
    expect.stringContaining("Fills"),
  ]);
});

it("keeps My Library and Discover loopers in the left-pane header", async () => {
  render(<Sidebar {...props} />);
  await act(async () => {});
  const tabs = screen.getByRole("tablist", { name: "Library views" });
  expect(screen.getByRole("navigation", { name: "Looper library" }).contains(tabs)).toBe(true);
  expect(tabs.contains(screen.getByRole("tab", { name: "My Library" }))).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Discover loopers" }));
  expect(props.onLibraryViewChange).toHaveBeenCalledWith("tablist");
});

it("keeps BPM on one line in fixed-height rows and uses smaller loop titles", async () => {
  vi.mocked(libraryList).mockResolvedValue([{ ...track(1, "Long loop name"), bpm: 137, source_type: "swf", looper_name: "Pack", source_hash: "swf-a" }]);
  render(<Sidebar {...props} />);
  await act(async () => {});
  const row = document.querySelector('[data-library-track-id="1"]')!;
  const bpm = row.querySelector("[data-bpm-cell]")!;
  const title = screen.getByText("Long loop name");
  expect(row.classList.contains("h-11")).toBe(true);
  expect((row as HTMLElement).style.height).toBe("44px");
  expect(bpm.classList.contains("whitespace-nowrap")).toBe(true);
  expect(title.classList.contains("text-[10px]")).toBe(true);
  expect(title.classList.contains("whitespace-nowrap")).toBe(true);
});

it("hides the looper column while a single looper is selected", async () => {
  localStorage.setItem("olooper.library.selectedGroup", "swf-a");
  vi.mocked(libraryList).mockResolvedValue([
    { ...track(1, "Break"), source_type: "swf", looper_name: "Break Pack", source_hash: "swf-a" },
  ]);
  render(<Sidebar {...props} />);
  await act(async () => {});
  expect(screen.queryByText("Looper")).toBeNull();
});

it("prefetches the loop that the Next button will play", async () => {
  vi.useFakeTimers();
  vi.mocked(libraryList).mockResolvedValue([
    { ...track(1, "First"), source_type: "swf", looper_name: "Pack", source_hash: "swf-a" },
    { ...track(2, "Second"), source_type: "swf", looper_name: "Pack", source_hash: "swf-a" },
  ]);
  render(<Sidebar {...props} activeTrackId={1} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(playerPrefetch).toHaveBeenCalledWith(2);
});

it("bounds mounted rows for a large catalog", async () => {
  vi.mocked(libraryList).mockResolvedValue(Array.from({ length: 1000 }, (_, id) => track(id, `Loop ${id}`)));
  render(<Sidebar {...props} />);
  await act(async () => {});
  const rows = document.querySelectorAll("[data-library-track-id]");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(40);
});

it("requests whole-library reanalysis independently of visible search filters", async () => {
  vi.mocked(libraryList).mockResolvedValue([track(1, "Hidden loop")]);
  const request = vi.fn();
  window.addEventListener("olooper:reanalyze-bpm", request);
  try {
    render(<Sidebar {...props} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tracks" }), { target: { value: "does not match" } });
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze all BPM" }));
    expect((request.mock.calls[0][0] as CustomEvent).detail.scope).toEqual({ kind: "library" });
  } finally { window.removeEventListener("olooper:reanalyze-bpm", request); }
});

it("requests the selected playlist scope instead of copying its tracks or using screen filters", async () => {
  localStorage.setItem("olooper.library.selectedGroup", "__olooper_playlist__:7");
  vi.mocked(libraryPlaylists).mockResolvedValueOnce([{ id: 7, name: "Practice", track_ids: [1] }]);
  vi.mocked(libraryList).mockResolvedValue([track(1, "Beat")]);
  const request = vi.fn();
  window.addEventListener("olooper:reanalyze-bpm", request);
  try {
    render(<Sidebar {...props} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze playlist BPM" }));
    expect((request.mock.calls[0][0] as CustomEvent).detail.scope).toEqual({ kind: "playlist", playlist_id: 7 });
  } finally { window.removeEventListener("olooper:reanalyze-bpm", request); }
});

it("offers a folder rescan for missing extracted audio without trying to play it", async () => {
  vi.mocked(libraryList).mockResolvedValue([{ ...track(1, "Gone"), exists: false, source_type: "swf", source_hash: "source-hash" }]);
  const request = vi.fn();
  window.addEventListener("olooper:rescan-source-folder", request);
  try {
    render(<Sidebar {...props} />);
    await act(async () => {});
    const row = document.querySelector('[data-library-track-id="1"]')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Play now" }));
    expect(screen.getByRole("dialog").textContent).toContain("Audio not found");
    fireEvent.click(screen.getByRole("button", { name: "Rescan source folder…" }));
    expect((request.mock.calls[0][0] as CustomEvent).detail).toBe("source-hash");
    expect(props.onTrackLoading).not.toHaveBeenCalled();
  } finally { window.removeEventListener("olooper:rescan-source-folder", request); }
});
