import type { Track } from "./tauri";

export interface RandomCandidate {
  track: Track;
  key: string;
}

/** Consume a prepared random target only if the scope and current track still match. */
export function takeRandomCandidate(
  candidate: RandomCandidate | null,
  key: string,
  activeTrackId: number | null,
): Track | null {
  if (!candidate || candidate.key !== key || !candidate.track.exists) return null;
  if (candidate.track.id === activeTrackId) return null;
  return candidate.track;
}
