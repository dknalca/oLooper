const MIN_INTERVAL_MS = 200;
const MAX_INTERVAL_MS = 2000;
const MAX_INTERVALS = 7;
const REQUIRED_INTERVALS = 3;

export interface TapTempoUpdate {
  taps: number[];
  bpm: number | null;
}

/** Estimate quarter-note BPM from the recent tap intervals. */
export function recordTempoTap(previousTaps: number[], timestampMs: number): TapTempoUpdate {
  if (!Number.isFinite(timestampMs)) return { taps: previousTaps, bpm: null };

  const previous = previousTaps[previousTaps.length - 1];
  const interval = previous === undefined ? null : timestampMs - previous;
  const startsNewSequence = interval === null
    || !Number.isFinite(interval)
    || interval < MIN_INTERVAL_MS
    || interval > MAX_INTERVAL_MS;
  const taps = startsNewSequence
    ? [timestampMs]
    : [...previousTaps, timestampMs].slice(-(MAX_INTERVALS + 1));
  const intervals = taps.slice(1).map((tap, index) => tap - taps[index]);
  if (intervals.length < REQUIRED_INTERVALS) return { taps, bpm: null };

  const sorted = [...intervals].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  const bpm = Math.round(60_000 / median);
  return { taps, bpm: bpm >= 30 && bpm <= 300 ? bpm : null };
}
