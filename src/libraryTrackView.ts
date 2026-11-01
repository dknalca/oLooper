import { IMPORTED_AUDIO_GROUP_KEY, libraryGroupKey, libraryGroupName } from "./libraryGroups";
import type { Playlist, Track } from "./tauri";

export interface LibraryFilters {
  search: string;
  sourceFilter: string;
  bpmFilter: string;
  durationFilter: string;
}

/** Preserve saved looper order, then unlisted groups and finally imported audio. */
export function libraryLooperGroups(tracks: Track[], looperOrder: string[]): Track[][] {
  const positions = new Map(looperOrder.map((hash, index) => [hash, index]));
  return Object.values(tracks.reduce<Record<string, Track[]>>((result, track) => {
    (result[libraryGroupKey(track)] ??= []).push(track);
    return result;
  }, {})).sort((left, right) => {
    const leftHash = libraryGroupKey(left[0]);
    const rightHash = libraryGroupKey(right[0]);
    if (leftHash === IMPORTED_AUDIO_GROUP_KEY) return rightHash === IMPORTED_AUDIO_GROUP_KEY ? 0 : 1;
    if (rightHash === IMPORTED_AUDIO_GROUP_KEY) return -1;
    const leftPosition = positions.get(leftHash) ?? -1;
    const rightPosition = positions.get(rightHash) ?? -1;
    if (leftPosition < 0 && rightPosition < 0) return left[0].id - right[0].id;
    if (leftPosition < 0) return 1;
    if (rightPosition < 0) return -1;
    return leftPosition - rightPosition;
  });
}

/** Filter before sorting and selecting a collection, so playlist order remains intact. */
export function filterLibraryTracks(tracks: Track[], { search, sourceFilter, bpmFilter, durationFilter }: LibraryFilters): Track[] {
  const needle = search.toLowerCase();
  return tracks.filter((track) => {
    const matchesSearch = !search || track.title.toLowerCase().includes(needle) || libraryGroupName(track).toLowerCase().includes(needle) || track.tags.toLowerCase().includes(needle);
    const matchesSource = sourceFilter === "all" || track.source_type === sourceFilter;
    const matchesBpm = bpmFilter === "all" || (track.bpm !== null && (bpmFilter === "low" ? track.bpm < 100 : bpmFilter === "mid" ? track.bpm <= 130 : track.bpm > 130));
    const matchesDuration = durationFilter === "all" || (durationFilter === "short" ? track.duration_ms < 10_000 : durationFilter === "mid" ? track.duration_ms <= 30_000 : track.duration_ms > 30_000);
    return matchesSearch && matchesSource && matchesBpm && matchesDuration;
  });
}

export function sortLibraryTracks(tracks: Track[], sort: "alphabetical" | "bpm", bpmDescending: boolean): Track[] {
  return [...tracks].sort((a, b) => {
    if (sort === "bpm" && a.bpm !== b.bpm) {
      if (a.bpm === null) return 1;
      if (b.bpm === null) return -1;
      return (a.bpm - b.bpm) * (bpmDescending ? -1 : 1);
    }
    return a.title.localeCompare(b.title);
  });
}

export function collectionTracks(
  playlist: Playlist | undefined, filteredById: Map<number, Track>, sorted: Track[],
  selectedGroup: string, allGroup: string, favoritesGroup: string,
): Track[] {
  if (playlist) return playlist.track_ids.flatMap((id) => {
    const track = filteredById.get(id);
    return track ? [track] : [];
  });
  return sorted.filter((track) => selectedGroup === allGroup
    || (selectedGroup === favoritesGroup ? track.favorite : libraryGroupKey(track) === selectedGroup));
}
