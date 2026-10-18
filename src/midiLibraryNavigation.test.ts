import { describe, expect, it } from "vitest";
import { midiEncoderDirection, navigateMidiLibrary, type MidiLibraryCollection } from "./midiLibraryNavigation";

const collections: MidiLibraryCollection[] = [
  { key: "playlist:one", trackIds: [11, 12] },
  { key: "looper:two", trackIds: [21] },
];

describe("MIDI library navigation", () => {
  it("moves among collections and clamps at the ends", () => {
    const first = { level: "collections", collectionIndex: 0 } as const;
    expect(navigateMidiLibrary(first, "up", collections).state).toEqual(first);
    expect(navigateMidiLibrary(first, "down", collections).state).toEqual({ level: "collections", collectionIndex: 1 });
    expect(navigateMidiLibrary({ level: "collections", collectionIndex: 1 }, "down", collections).state)
      .toEqual({ level: "collections", collectionIndex: 1 });
  });

  it("enters a collection, wraps loop selection, plays on Intro, and backs out", () => {
    const entered = navigateMidiLibrary({ level: "collections", collectionIndex: 0 }, "intro", collections);
    expect(entered).toEqual({ state: { level: "tracks", collectionIndex: 0, trackIndex: 0 }, playTrackId: null });
    expect(navigateMidiLibrary(entered.state, "up", collections).state)
      .toEqual({ level: "tracks", collectionIndex: 0, trackIndex: 1 });
    const secondTrack = navigateMidiLibrary(entered.state, "down", collections);
    expect(secondTrack.state).toEqual({ level: "tracks", collectionIndex: 0, trackIndex: 1 });
    expect(navigateMidiLibrary(secondTrack.state, "down", collections).state)
      .toEqual({ level: "tracks", collectionIndex: 0, trackIndex: 0 });
    expect(navigateMidiLibrary(secondTrack.state, "intro", collections).playTrackId).toBe(12);
    expect(navigateMidiLibrary(secondTrack.state, "back", collections).state)
      .toEqual({ level: "collections", collectionIndex: 0 });
  });

  it("does nothing on Back at collection level and tolerates empty collections", () => {
    const root = { level: "collections", collectionIndex: 0 } as const;
    expect(navigateMidiLibrary(root, "back", collections).state).toEqual(root);
    expect(navigateMidiLibrary({ level: "collections", collectionIndex: 1 }, "intro", [
      collections[0], { key: "empty", trackIds: [] },
    ]).playTrackId).toBeNull();
  });

  it("interprets relative encoder turns and ignores release/center values", () => {
    expect(midiEncoderDirection(1)).toBe(1);
    expect(midiEncoderDirection(63)).toBe(1);
    expect(midiEncoderDirection(65)).toBe(-1);
    expect(midiEncoderDirection(127)).toBe(-1);
    expect(midiEncoderDirection(0)).toBe(0);
    expect(midiEncoderDirection(64)).toBe(0);
  });
});
