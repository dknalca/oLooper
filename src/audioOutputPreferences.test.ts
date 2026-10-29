import { describe, expect, it } from "vitest";
import {
  normalizeStereoPair,
  readAudioSelection,
  parseOutputPairSelections,
  rememberedOutputPair,
  rememberOutputPair,
} from "./audioOutputPreferences";

describe("audio output pair preferences", () => {
  it("reads a saved output and normalizes its stereo pair", () => {
    const storage = { getItem: () => JSON.stringify({ deviceName: "DJM", firstChannel: 3, sampleRate: 48000, bufferFrames: 256 }) };
    expect(readAudioSelection(storage)).toEqual({ deviceName: "DJM", firstChannel: 2, sampleRate: 48000, bufferFrames: 256 });
  });

  it("uses the default for invalid selection or unavailable storage", () => {
    const expected = { deviceName: null, firstChannel: 0, sampleRate: null, bufferFrames: null };
    for (const saved of [null, "not-json", '{"deviceName":"DJM","firstChannel":63}']) {
      expect(readAudioSelection({ getItem: () => saved })).toEqual(expected);
    }
    expect(readAudioSelection({ getItem: () => { throw new Error("unavailable"); } })).toEqual(expected);
  });

  it("ignores invalid sample rate and buffer without discarding the output", () => {
    const storage = { getItem: () => '{"deviceName":"DJM","firstChannel":2,"sampleRate":0,"bufferFrames":"256"}' };
    expect(readAudioSelection(storage)).toEqual({ deviceName: "DJM", firstChannel: 2, sampleRate: null, bufferFrames: null });
  });

  it.each([0, 1, 61, 62])("accepts and normalizes valid channel %s with the system output", (channel) => {
    const storage = { getItem: () => JSON.stringify({ deviceName: null, firstChannel: channel, sampleRate: 44100, bufferFrames: 512 }) };
    expect(readAudioSelection(storage)).toEqual({ deviceName: null, firstChannel: Math.floor(channel / 2) * 2, sampleRate: 44100, bufferFrames: 512 });
  });

  it.each([
    { deviceName: "DJM", firstChannel: -1 },
    { deviceName: "DJM", firstChannel: 2.5 },
    { deviceName: "DJM", firstChannel: "2" },
    { deviceName: 0, firstChannel: 2 },
    { firstChannel: 2 },
    [],
  ])("uses the default for an invalid device or channel: %j", (saved) => {
    expect(readAudioSelection({ getItem: () => JSON.stringify(saved) })).toEqual({ deviceName: null, firstChannel: 0, sampleRate: null, bufferFrames: null });
  });

  it("keeps a valid device while rejecting fractional or negative optional values", () => {
    const storage = { getItem: () => JSON.stringify({ deviceName: "DJM", firstChannel: 2, sampleRate: 44100.5, bufferFrames: -1 }) };
    expect(readAudioSelection(storage)).toEqual({ deviceName: "DJM", firstChannel: 2, sampleRate: null, bufferFrames: null });
  });

  it("remembers a separate stereo pair for each device", () => {
    const djm = { deviceName: "DJM-S11", firstChannel: 2, sampleRate: 48000, bufferFrames: 256 };
    const speakers = { deviceName: "Built-in Output", firstChannel: 0, sampleRate: null, bufferFrames: null };
    const saved = rememberOutputPair(rememberOutputPair({}, djm), speakers);

    expect(rememberedOutputPair(saved, "DJM-S11")).toBe(2);
    expect(rememberedOutputPair(saved, "Built-in Output")).toBe(0);
    expect(rememberedOutputPair(saved, null)).toBe(0);
  });

  it("ignores malformed or out-of-range saved pairs", () => {
    expect(parseOutputPairSelections("not-json")).toEqual({});
    expect(parseOutputPairSelections(JSON.stringify({ good: 2, negative: -1, string: "1", huge: 63 })))
      .toEqual({ good: 2 });
  });

  it("migrates overlapping channel choices to complete stereo pairs", () => {
    expect(normalizeStereoPair(1)).toBe(0);
    expect(normalizeStereoPair(3)).toBe(2);
    expect(parseOutputPairSelections('{"DJM-S11":1}')).toEqual({ "DJM-S11": 0 });
  });
});
