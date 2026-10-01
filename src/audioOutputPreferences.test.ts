import { describe, expect, it } from "vitest";
import {
  parseOutputPairSelections,
  rememberedOutputPair,
  rememberOutputPair,
} from "./audioOutputPreferences";

describe("audio output pair preferences", () => {
  it("remembers a separate stereo pair for each device", () => {
    const djm = { deviceName: "DJM-S11", firstChannel: 1 };
    const speakers = { deviceName: "Built-in Output", firstChannel: 0 };
    const saved = rememberOutputPair(rememberOutputPair({}, djm), speakers);

    expect(rememberedOutputPair(saved, "DJM-S11")).toBe(1);
    expect(rememberedOutputPair(saved, "Built-in Output")).toBe(0);
    expect(rememberedOutputPair(saved, null)).toBe(0);
  });

  it("ignores malformed or out-of-range saved pairs", () => {
    expect(parseOutputPairSelections("not-json")).toEqual({});
    expect(parseOutputPairSelections(JSON.stringify({ good: 2, negative: -1, string: "1", huge: 63 })))
      .toEqual({ good: 2 });
  });
});
