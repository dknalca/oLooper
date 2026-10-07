import { describe, expect, it } from "vitest";
import { recordTempoTap } from "./tapTempo";

describe("Tap Tempo", () => {
  it("estimates 120 BPM after four quarter-note taps", () => {
    let taps: number[] = [];
    let bpm: number | null = null;
    for (const timestamp of [0, 500, 1000, 1500]) {
      ({ taps, bpm } = recordTempoTap(taps, timestamp));
    }
    expect(bpm).toBe(120);
  });

  it("uses the median of recent intervals to ignore a jittered tap", () => {
    let taps: number[] = [];
    let bpm: number | null = null;
    for (const timestamp of [0, 500, 1000, 1850, 2350]) {
      ({ taps, bpm } = recordTempoTap(taps, timestamp));
    }
    expect(bpm).toBe(120);
  });

  it("starts a new sequence after a long pause or an out-of-range tap", () => {
    expect(recordTempoTap([0, 500, 1000], 4000)).toEqual({ taps: [4000], bpm: null });
    expect(recordTempoTap([0, 500, 1000], 1150)).toEqual({ taps: [1150], bpm: null });
  });

  it("accepts the lower supported tempo of 30 BPM", () => {
    let taps: number[] = [];
    let bpm: number | null = null;
    for (const timestamp of [0, 2000, 4000, 6000]) {
      ({ taps, bpm } = recordTempoTap(taps, timestamp));
    }
    expect(bpm).toBe(30);
  });

  it("keeps a bounded recent history and adapts to a new tempo", () => {
    let taps: number[] = [];
    let bpm: number | null = null;
    for (const timestamp of [0, 500, 1000, 1500, 1700, 1900, 2100, 2300, 2500, 2700, 2900, 3100]) {
      ({ taps, bpm } = recordTempoTap(taps, timestamp));
    }
    expect(taps).toHaveLength(8);
    expect(bpm).toBe(300);
  });

  it("rejects nonfinite timestamps without corrupting the current sequence", () => {
    const taps = [0, 500, 1000];
    expect(recordTempoTap(taps, NaN)).toEqual({ taps, bpm: null });
    expect(recordTempoTap(taps, Infinity)).toEqual({ taps, bpm: null });
  });
});
