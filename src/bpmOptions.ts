export interface BpmBase {
  bpm: number;
  origin: "detected" | "current" | "entered" | "tapped";
  confidence?: number | null;
  loop?: { frames: number; rate: number; bars: number };
}

export interface BpmOption {
  kind: "half" | "normal" | "double";
  bpm: number;
  label: string;
}

export function validBpm(bpm: number): boolean {
  return Number.isFinite(bpm) && bpm >= 20 && bpm <= 300;
}

export function formatBpm(bpm: number): string {
  return Number(bpm.toFixed(2)).toString();
}

/** Ratios always refer to the unchanged base, never to the selected draft. */
export function bpmOptions(base: BpmBase | null): BpmOption[] {
  if (!base || !validBpm(base.bpm)) return [];
  const normalLabel = { detected: "Detected", current: "Current", entered: "Entered", tapped: "Tapped" }[base.origin];
  const variants = [
    { kind: "half" as const, factor: 0.5, label: "Half" },
    { kind: "normal" as const, factor: 1, label: normalLabel },
    { kind: "double" as const, factor: 2, label: "Double" },
  ];
  return variants.flatMap(({ kind, factor, label }) => {
    const bpm = base.bpm * factor;
    if (!validBpm(bpm)) return [];
    if (base.loop) {
      const { frames, rate, bars } = base.loop;
      if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(rate) || rate <= 0
        || !Number.isSafeInteger(bars) || bars < 1) return [];
      const exactBase = 240 * bars * rate / frames;
      // The detector presents tenths; validate the inferred exact duration tempo
      // before rounding and test whole-bar compatibility using its bar count.
      if (Math.abs(exactBase - base.bpm) > 0.051 || !validBpm(exactBase * factor)
        || !Number.isInteger(bars * factor) || bars * factor < 1) return [];
    }
    return [{ kind, bpm, label: `${label} · ${formatBpm(bpm)} BPM` }];
  });
}
