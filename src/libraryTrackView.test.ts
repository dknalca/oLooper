import { expect, it } from "vitest";
import { collectionTracks, filterLibraryTracks, libraryLooperGroups, sortLibraryTracks } from "./libraryTrackView";
import type { Playlist, Track } from "./tauri";

const track = (id: number, title: string, bpm: number | null, duration_ms: number): Track => ({
  id, title, bpm, duration_ms, source_type: "swf", source_hash: "pack", looper_name: "Scratch Pack", tags: "cuts", favorite: false,
} as Track);
const tracks = [track(1, "Alpha", 100, 10_000), track(2, "Beta", 130, 30_000), track(3, "Gamma", null, 30_001), track(4, "Delta", 99, 9_999)];
const all = { search: "", sourceFilter: "all", bpmFilter: "all", durationFilter: "all" };
const ids = (items: Track[]) => items.map((item) => item.id);

it("filters boundaries, missing BPM and search across group names and tags", () => {
  // The existing "mid" filters use upper bounds, not exclusive ranges.
  expect(ids(filterLibraryTracks(tracks, { ...all, bpmFilter: "mid", durationFilter: "mid" }))).toEqual([1, 2, 4]);
  expect(ids(filterLibraryTracks(tracks, { ...all, bpmFilter: "low", durationFilter: "short" }))).toEqual([4]);
  expect(ids(filterLibraryTracks(tracks, { ...all, bpmFilter: "high" }))).toEqual([]);
  expect(ids(filterLibraryTracks(tracks, { ...all, search: "SCRATCH" }))).toEqual([1, 2, 3, 4]);
  expect(ids(filterLibraryTracks(tracks, { ...all, search: "CUTS", sourceFilter: "custom" }))).toEqual([]);
});

it("sorts missing BPM last in either direction without mutating input", () => {
  expect(ids(sortLibraryTracks(tracks, "bpm", false))).toEqual([4, 1, 2, 3]);
  expect(ids(sortLibraryTracks(tracks, "bpm", true))).toEqual([2, 1, 4, 3]);
  expect(ids(tracks)).toEqual([1, 2, 3, 4]);
});

it("keeps playlist order and skips filtered or missing tracks", () => {
  const filtered = new Map([[1, tracks[0]], [2, tracks[1]]]);
  const playlist = { id: 5, track_ids: [2, 3, 1, 99] } as Playlist;
  expect(ids(collectionTracks(playlist, filtered, tracks, "playlist", "all", "favorites"))).toEqual([2, 1]);
  expect(ids(collectionTracks(undefined, filtered, tracks, "pack", "all", "favorites"))).toEqual([1, 2, 3, 4]);
  expect(ids(collectionTracks(undefined, filtered, [{ ...tracks[0], favorite: true }, tracks[1]], "favorites", "all", "favorites"))).toEqual([1]);
});

it("groups custom audio last while respecting saved and unlisted looper order", () => {
  const input = [
    { ...tracks[0], id: 7, source_hash: "unknown-later" },
    { ...tracks[1], id: 9, source_hash: "saved" },
    { ...tracks[2], id: 2, source_hash: "unknown-first" },
    { ...tracks[3], id: 1, source_type: "custom", source_hash: "custom-one" },
    { ...tracks[3], id: 10, source_type: "custom", source_hash: "custom-two" },
  ];
  expect(libraryLooperGroups(input, ["saved"]).map((group) => group.map((item) => item.id))).toEqual([[9], [2], [7], [1, 10]]);
});
