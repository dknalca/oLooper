import { describe, expect, it } from "vitest";
import { IMPORTED_AUDIO_GROUP_KEY, libraryGroupKey, libraryGroupName } from "./libraryGroups";

describe("library group presentation", () => {
  it("unifies imported audio in the UI without changing per-file identities", () => {
    const first = { source_type: "custom", source_hash: "hash-a", looper_name: "Custom Loops" };
    const second = { source_type: "custom", source_hash: "hash-b", looper_name: "Custom Loops" };

    expect(libraryGroupKey(first)).toBe(IMPORTED_AUDIO_GROUP_KEY);
    expect(libraryGroupKey(second)).toBe(IMPORTED_AUDIO_GROUP_KEY);
    expect(first.source_hash).not.toBe(second.source_hash);
    expect(libraryGroupName(first)).toBe("Audios importados");
  });

  it("keeps SWF/EXE groups keyed by their source identity", () => {
    const track = { source_type: "swf", source_hash: "swf-hash", looper_name: "Break Pack" };
    expect(libraryGroupKey(track)).toBe("swf-hash");
    expect(libraryGroupName(track)).toBe("Break Pack");
  });
});
