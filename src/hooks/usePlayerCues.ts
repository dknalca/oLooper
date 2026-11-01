import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import {
  libraryGetSeratoMetadata, librarySetSeratoCue, librarySyncSeratoMetadata, playerSeek,
  type PlayerStatus, type SeratoCue, type SeratoMetadata, type TrackBpmUpdate,
} from "../tauri";

interface Options {
  trackId: number | null;
  trackOpenGeneration: number;
  audioStorage: "extracted" | "embedded";
  status: PlayerStatus | null;
  matchesPlayback: boolean;
  statusRef: MutableRefObject<PlayerStatus | null>;
  ownerRef: MutableRefObject<string>;
  setError: (error: string | null) => void;
  run: (request: Promise<PlayerStatus>) => void;
}

/** Own marker reads, writes, sync feedback and keyboard/MIDI CUE shortcuts. */
export function usePlayerCues({ trackId, trackOpenGeneration, audioStorage, status: st, matchesPlayback, statusRef, ownerRef, setError, run }: Options) {
  const [cues, setCues] = useState<SeratoCue[]>([]);
  const [metadataTrackId, setMetadataTrackId] = useState<number | null>(null);
  const [activeCueSlot, setActiveCueSlot] = useState<number | null>(null);
  const [seratoSyncing, setSeratoSyncing] = useState(false);
  const [seratoSyncMessage, setSeratoSyncMessage] = useState<string | null>(null);
  const [seratoSyncError, setSeratoSyncError] = useState(false);

  useEffect(() => {
    setSeratoSyncMessage(null);
    setSeratoSyncError(false);
    setSeratoSyncing(false);
  }, [trackId]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<SeratoCue[]>("olooper:cues", { detail: cues }));
  }, [cues]);

  useEffect(() => {
    let cancelled = false;
    setCues([]);
    setMetadataTrackId(null);
    setActiveCueSlot(null);
    if (!trackId || !st?.loaded || !matchesPlayback) return () => { cancelled = true; };
    libraryGetSeratoMetadata(trackId)
      .then((metadata) => {
        if (cancelled) return;
        setCues(metadata.cues);
        setMetadataTrackId(trackId);
        setError(null);
        if (metadata.bpm !== null) {
          window.dispatchEvent(new CustomEvent("olooper:track-bpm", {
            detail: { trackId, bpm: metadata.bpm, source: metadata.bpm_source, confidence: metadata.bpm_confidence } satisfies TrackBpmUpdate,
          }));
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(`Cannot read CUEs from audio file: ${String(cause)}`);
      });
    return () => { cancelled = true; };
  }, [trackId, trackOpenGeneration, st?.generation, st?.path, st?.loaded, matchesPlayback, setError]);

  const applyMetadata = (metadata: SeratoMetadata) => {
    setCues(metadata.cues);
    if (metadata.bpm !== null && trackId !== null) {
      window.dispatchEvent(new CustomEvent("olooper:track-bpm", {
        detail: { trackId, bpm: metadata.bpm, source: metadata.bpm_source, confidence: metadata.bpm_confidence } satisfies TrackBpmUpdate,
      }));
    }
  };

  const saveCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId || st?.loading || !matchesPlayback) return;
    const cueMs = statusRef.current?.position_ms ?? 0;
    const owner = ownerRef.current;
    librarySetSeratoCue(trackId, slot, cueMs)
      .then((metadata) => {
        if (owner !== ownerRef.current) return;
        applyMetadata(metadata);
        setActiveCueSlot(slot);
      })
      .catch((cause) => { if (owner === ownerRef.current) setError(String(cause)); });
  };

  const syncSeratoMetadata = useCallback(async (id: number) => {
    const owner = ownerRef.current;
    setSeratoSyncing(true);
    setSeratoSyncError(false);
    setSeratoSyncMessage("Writing CUEs and BPM to the audio file…");
    try {
      await librarySyncSeratoMetadata(id);
      if (owner !== ownerRef.current) return;
      setSeratoSyncMessage("Serato metadata synced. Reload this file in Serato to refresh it.");
    } catch (cause) {
      if (owner !== ownerRef.current) return;
      setSeratoSyncError(true);
      setSeratoSyncMessage(`Data is saved in oLooper, but Serato sync failed: ${String(cause)}`);
    } finally {
      if (owner === ownerRef.current) setSeratoSyncing(false);
    }
  }, [ownerRef]);

  const loadCue = (slot: number) => {
    if (metadataTrackId !== trackId || st?.loading || !matchesPlayback) return;
    const cue = cues.find((saved) => saved.slot === slot);
    if (!cue) return;
    setActiveCueSlot(slot);
    run(playerSeek(cue.position_ms));
  };

  const clearCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId || slot === 1 || st?.loading || !matchesPlayback) return;
    const owner = ownerRef.current;
    librarySetSeratoCue(trackId, slot, null)
      .then((metadata) => {
        if (owner !== ownerRef.current) return;
        applyMetadata(metadata);
        if (activeCueSlot === slot) setActiveCueSlot(null);
      })
      .catch((cause) => { if (owner === ownerRef.current) setError(String(cause)); });
  };

  useEffect(() => {
    const handleCueShortcut = (event: Event) => {
      const { slot, clear } = (event as CustomEvent<{ slot: number; clear: boolean }>).detail;
      if (!trackId || !st?.loaded || st.loading || !matchesPlayback || !Number.isInteger(slot) || slot < 1 || slot > 4) return;
      if (audioStorage === "embedded" && slot !== 1) return;
      if (slot === 1) loadCue(1);
      else if (clear) clearCue(slot);
      else if (metadataTrackId !== trackId) return;
      else if (cues.some((cue) => cue.slot === slot)) loadCue(slot);
      else saveCue(slot);
    };
    window.addEventListener("olooper:cue-shortcut", handleCueShortcut);
    return () => window.removeEventListener("olooper:cue-shortcut", handleCueShortcut);
  }, [audioStorage, trackId, st?.loaded, metadataTrackId, cues, clearCue, loadCue, saveCue]);

  return { cues, metadataTrackId, activeCueSlot, seratoSyncing, seratoSyncMessage, seratoSyncError, loadCue, saveCue, clearCue, syncSeratoMetadata };
}
