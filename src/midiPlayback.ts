export interface MidiStartTrack {
  exists: boolean;
  favorite: boolean;
  source_hash: string;
  title: string;
  bpm: number | null;
}

function inLibraryOrder<T extends MidiStartTrack>(tracks: readonly T[], sortPreference: string | null): T[] {
  return [...tracks].sort((a, b) => {
    if (sortPreference === "bpm" || sortPreference === "bpm-desc") {
      if (a.bpm !== b.bpm) {
        if (a.bpm === null) return 1;
        if (b.bpm === null) return -1;
        return (a.bpm - b.bpm) * (sortPreference === "bpm-desc" ? -1 : 1);
      }
    }
    return a.title.localeCompare(b.title);
  });
}

/** First playable favorite, otherwise the first playable track of the first playable looper. */
export function firstMidiStartTrack<T extends MidiStartTrack>(
  tracks: readonly T[],
  sortPreference: string | null,
): T | null {
  const playable = tracks.filter((track) => track.exists);
  const orderedFavorites = inLibraryOrder(playable.filter((track) => track.favorite), sortPreference);
  if (orderedFavorites.length > 0) return orderedFavorites[0];

  const firstLooper = playable[0]?.source_hash;
  if (!firstLooper) return null;
  return inLibraryOrder(
    playable.filter((track) => track.source_hash === firstLooper),
    sortPreference,
  )[0] ?? null;
}
