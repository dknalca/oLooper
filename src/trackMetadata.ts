export interface TrackMetadataDraft {
  title: string;
  bpm: string;
  tags: string;
}

export type PreparedTrackMetadata =
  | { ok: false; error: string }
  | { ok: true; title: string; bpm: number | null; tags: string; confirmManualBpm: boolean };

/** Validate the editor draft without implicitly confirming an unchanged tempo. */
export function prepareTrackMetadata(
  draft: TrackMetadataDraft,
  currentBpm: number | null,
  bpmConfirmed: boolean,
): PreparedTrackMetadata {
  const title = draft.title.trim();
  if (!title) return { ok: false, error: "Loop title cannot be empty." };
  const bpmText = draft.bpm.trim();
  const bpm = bpmText ? Number(bpmText) : currentBpm;
  if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) {
    return { ok: false, error: "BPM must be between 20 and 300." };
  }
  return {
    ok: true,
    title,
    bpm,
    tags: draft.tags.trim(),
    confirmManualBpm: bpmText.length > 0 && (bpmConfirmed || bpm !== currentBpm),
  };
}
