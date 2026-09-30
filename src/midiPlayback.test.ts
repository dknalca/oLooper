import { describe, expect, it } from "vitest";
import { firstMidiStartTrack } from "./midiPlayback";

const track = (id: string, values: Partial<{
  exists: boolean;
  favorite: boolean;
  source_hash: string;
  title: string;
  bpm: number | null;
}> = {}) => ({
  id,
  exists: true,
  favorite: false,
  source_hash: "looper-1",
  title: id,
  bpm: null,
  ...values,
});

describe("firstMidiStartTrack", () => {
  it("chooses the first playable favorite", () => {
    const a = track("A", { favorite: true });
    const b = track("B", { favorite: true });
    expect(firstMidiStartTrack([b, a], "alphabetical")).toBe(a);
  });

  it("falls back to the first playable track in the first playable looper", () => {
    const firstLooperTrack = track("B", { source_hash: "looper-1" });
    const nextLooperTrack = track("A", { source_hash: "looper-2" });
    expect(firstMidiStartTrack([firstLooperTrack, nextLooperTrack], "alphabetical")).toBe(firstLooperTrack);
  });

  it("ignores unavailable tracks and honors the saved BPM sort", () => {
    const unavailable = track("A", { favorite: true, exists: false });
    const slower = track("B", { favorite: true, bpm: 90 });
    const faster = track("C", { favorite: true, bpm: 120 });
    expect(firstMidiStartTrack([unavailable, faster, slower], "bpm-desc")).toBe(faster);
  });

  it("returns null when the library has no playable tracks", () => {
    expect(firstMidiStartTrack([track("missing", { exists: false })], "alphabetical")).toBeNull();
  });
});
