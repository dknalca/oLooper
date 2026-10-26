import { expect, it } from "vitest";
import { bpmOptions, type BpmBase } from "./bpmOptions";

const base = (bpm: number): BpmBase => ({ bpm, origin: "current" });

it("offers exact ratios and rejects out-of-range values before display rounding", () => {
  expect(bpmOptions(base(100)).map((option) => option.bpm)).toEqual([50, 100, 200]);
  expect(bpmOptions(base(160)).map((option) => option.bpm)).toEqual([80, 160]);
  expect(bpmOptions(base(30)).map((option) => option.bpm)).toEqual([30, 60]);
  expect(bpmOptions(base(150.001)).map((option) => option.bpm)).toEqual([75.0005, 150.001]);
  expect(bpmOptions(base(117.3))[0]).toEqual({ kind: "half", bpm: 58.65, label: "Half · 58.65 BPM" });
  for (const bpm of [NaN, Infinity, -Infinity, 0, -20, 19.999, 300.001]) expect(bpmOptions(base(bpm))).toEqual([]);
  expect(bpmOptions(null)).toEqual([]);
});

it("only offers whole-bar interpretations of a detected 4/4 loop", () => {
  expect(bpmOptions({ bpm: 120, origin: "detected", loop: { frames: 16000, rate: 8000, bars: 1 } }).map((option) => option.bpm)).toEqual([120, 240]);
  expect(bpmOptions({ bpm: 120, origin: "detected", loop: { frames: 32000, rate: 8000, bars: 2 } }).map((option) => option.bpm)).toEqual([60, 120, 240]);
  expect(bpmOptions({ bpm: 120, origin: "detected", loop: { frames: 32000, rate: 8000, bars: 3 } })).toEqual([]);
  expect(bpmOptions({ bpm: 120, origin: "detected", loop: { frames: 0, rate: 8000, bars: 2 } })).toEqual([]);
});

it("accounts for tenths rounding using the exact decoded bar count", () => {
  const frames = Math.round(8000 * 240 * 4 / 117.34);
  expect(bpmOptions({ bpm: 117.3, origin: "detected", loop: { frames, rate: 8000, bars: 4 } }).map((option) => option.bpm)).toEqual([58.65, 117.3, 234.6]);
});
