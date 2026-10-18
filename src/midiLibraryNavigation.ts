export interface MidiLibraryCollection {
  key: string;
  trackIds: number[];
}

export type MidiLibraryNavigationState =
  | { level: "collections"; collectionIndex: number }
  | { level: "tracks"; collectionIndex: number; trackIndex: number };

export type MidiLibraryNavigationAction = "up" | "down" | "intro" | "back";

export type MidiLibraryNavigationResult = {
  state: MidiLibraryNavigationState;
  playTrackId: number | null;
};

export function navigateMidiLibrary(
  state: MidiLibraryNavigationState,
  action: MidiLibraryNavigationAction,
  collections: readonly MidiLibraryCollection[],
): MidiLibraryNavigationResult {
  if (collections.length === 0) {
    return { state: { level: "collections", collectionIndex: 0 }, playTrackId: null };
  }

  const collectionIndex = Math.min(state.collectionIndex, collections.length - 1);
  if (state.level === "collections") {
    if (action === "up" || action === "down") {
      return {
        state: {
          level: "collections",
          collectionIndex: Math.max(0, Math.min(collections.length - 1, collectionIndex + (action === "up" ? -1 : 1))),
        },
        playTrackId: null,
      };
    }
    if (action === "intro") {
      return { state: { level: "tracks", collectionIndex, trackIndex: 0 }, playTrackId: null };
    }
    return { state: { level: "collections", collectionIndex }, playTrackId: null };
  }

  const collection = collections[collectionIndex];
  const trackCount = collection.trackIds.length;
  if (action === "back") {
    return { state: { level: "collections", collectionIndex }, playTrackId: null };
  }
  if (action === "up" || action === "down") {
    const direction = action === "up" ? -1 : 1;
    const trackIndex = trackCount === 0
      ? 0
      : ((state.trackIndex % trackCount) + trackCount + direction) % trackCount;
    return { state: { level: "tracks", collectionIndex, trackIndex }, playTrackId: null };
  }
  const trackId = collection.trackIds[state.trackIndex];
  return {
    state: { level: "tracks", collectionIndex, trackIndex: state.trackIndex },
    playTrackId: trackId ?? null,
  };
}

/** Relative MIDI CC encoders report positive/negative turns as values on either side of 64. */
export function midiEncoderDirection(value: number): -1 | 0 | 1 {
  if (!Number.isInteger(value) || value <= 0 || value > 127 || value === 64) return 0;
  return value < 64 ? 1 : -1;
}
