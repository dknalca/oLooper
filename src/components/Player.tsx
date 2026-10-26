import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling } from "../poll";
import { createRandomPlayback, type RandomSwitchOptions } from "../randomPlayback";
import {
  libraryGetSeratoMetadata,
  librarySetSeratoCue,
  librarySyncSeratoMetadata,
  playerPause,
  playerPlay,
  playerSeek,
  playerAutoLoop,
  playerSetLoopEnabled,
  playerSetLoopSnapped,
  playerSetSpeed,
  playerSetVolume,
  playerStatus,
  playerStop,
  type PlayerStatus,
  type SeratoCue,
  type SeratoMetadata,
} from "../tauri";
import { exposePlayerState } from "../hooks/useKeyboardShortcuts";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(
    Math.floor((ms % 1000) / 100),
  )}`;
}

const CUE_SLOTS = Array.from({ length: 4 }, (_, index) => index + 1);

interface Props {
  status: PlayerStatus | null;
  trackId: number | null;
  audioStorage: "extracted" | "embedded";
  playbackPath?: string | null;
  trackOpenGeneration: number;
  canRandom: boolean;
  onRandomTrack: (request?: RandomSwitchOptions) => Promise<boolean | void>;
  canNavigateTracks: boolean;
  onPreviousTrack: () => void;
  onNextTrack: () => void;
  loopEditing: boolean;
  onToggleLoopEditing: () => void;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Player({ status: st, trackId, audioStorage, playbackPath, trackOpenGeneration, canRandom, onRandomTrack, canNavigateTracks, onPreviousTrack, onNextTrack, loopEditing, onToggleLoopEditing, onStatusChange }: Props) {
  const matchesPlayback = !playbackPath || st?.path === playbackPath;
  const [error, setError] = useState<string | null>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const loopStartRef = useRef<HTMLInputElement>(null);
  const loopEndRef = useRef<HTMLInputElement>(null);
  const [loopStart, setLoopStart] = useState("0");
  const [loopEnd, setLoopEnd] = useState("");
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [randomEnabled, setRandomEnabled] = useState(false);
  const [randomInterval, setRandomInterval] = useState<"2" | "5" | "custom">("2");
  const [customMinutes, setCustomMinutes] = useState("10");
  const [randomRemaining, setRandomRemaining] = useState<number | null>(null);
  const randomActionRef = useRef(onRandomTrack);
  randomActionRef.current = onRandomTrack;
  const [randomPlayback] = useState(() => createRandomPlayback({
    action: (request) => randomActionRef.current(request),
    onRemaining: setRandomRemaining,
    onSuccess: () => setError(null),
    onError: (cause) => setError(`Random track: ${String(cause)}`),
  }));
  const minutes = randomInterval === "custom" ? Number(customMinutes) : Number(randomInterval);
  const validInterval = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440;

  useEffect(() => {
    randomPlayback.configure(randomEnabled && canRandom && validInterval ? minutes * 60_000 : null);
    return () => randomPlayback.configure(null);
  }, [randomEnabled, canRandom, validInterval, minutes, randomPlayback]);

  useEffect(() => { randomPlayback.updatePlayback(st); }, [st, randomPlayback]);

  useEffect(() => {
    const random = () => { if (canRandom) void randomPlayback.trigger(); };
    window.addEventListener("olooper:random-loop", random);
    return () => window.removeEventListener("olooper:random-loop", random);
  }, [canRandom, randomPlayback]);

  // CUEs live in the audio file, not the private catalog DB.
  const [cues, setCues] = useState<SeratoCue[]>([]);
  const [metadataTrackId, setMetadataTrackId] = useState<number | null>(null);
  const [activeCueSlot, setActiveCueSlot] = useState<number | null>(null);
  const [seratoSyncing, setSeratoSyncing] = useState(false);
  const [seratoSyncMessage, setSeratoSyncMessage] = useState<string | null>(null);
  const [seratoSyncError, setSeratoSyncError] = useState(false);
  const statusRef = useRef(st);
  const metadataOwner = useRef("");
  metadataOwner.current = `${trackId}:${trackOpenGeneration}:${st?.generation ?? 0}:${st?.path ?? ""}`;

  statusRef.current = st;

  useEffect(() => {
    setSeratoSyncMessage(null);
    setSeratoSyncError(false);
    setSeratoSyncing(false);
  }, [trackId]);

  useEffect(() => {
    if (!st?.loaded) {
      setLoopStart("0");
      setLoopEnd("");
      return;
    }
    if (document.activeElement !== loopStartRef.current) setLoopStart(String(st.loop_start_ms));
    if (document.activeElement !== loopEndRef.current) setLoopEnd(String(st.loop_end_ms));
  }, [st?.path, st?.loaded, st?.loop_start_ms, st?.loop_end_ms]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<SeratoCue[]>("olooper:cues", { detail: cues }));
  }, [cues]);

  useEffect(() => {
    setError(st?.output_error ? `Audio output: ${st.output_error}` : null);
  }, [st?.output_error]);

  const run = useCallback(
    (p: Promise<PlayerStatus>) => {
      const owner = metadataOwner.current;
      return p.then((s) => {
        if (owner !== metadataOwner.current) return;
        onStatusChange(s);
        setError(s.output_error ? `Audio output: ${s.output_error}` : null);
      }).catch((e) => { if (owner === metadataOwner.current) setError(String(e)); });
    },
    [onStatusChange],
  );

  const playNextRandom = randomPlayback.trigger;

  // Poll native position at 4 Hz while playing, and also while a
  // background job (decode/stretch) is pending so progress and async
  // errors surface without new event plumbing.
  useEffect(() => {
    if (!st?.playing && !st?.loading && !st?.pitch_preparing) return;
    let active = true;
    const stop = startPolling(async () => {
      const owner = metadataOwner.current;
      const status = await playerStatus();
      if (active && owner === metadataOwner.current) onStatusChange(status);
    }, 250, false);
    return () => { active = false; stop(); };
  }, [st?.playing, st?.loading, st?.pitch_preparing, onStatusChange]);

  // Expose state to keyboard shortcuts hook.
  useEffect(() => {
    if (st) {
      exposePlayerState({
        position_ms: st.position_ms,
        playing: st.playing,
        loaded: st.loaded && !st.loading && matchesPlayback,
        loop_enabled: st.loop_enabled,
        duration_ms: st.duration_ms,
      });
    } else exposePlayerState({ position_ms: 0, playing: false, loaded: false, loop_enabled: false, duration_ms: 0 });
  }, [st, matchesPlayback]);

  // Read markers from the audio file every time a track is opened.
  useEffect(() => {
    let cancelled = false;
    setCues([]);
    setMetadataTrackId(null);
    setActiveCueSlot(null);
    if (!trackId || !st?.loaded || !matchesPlayback) {
      return () => { cancelled = true; };
    }
    libraryGetSeratoMetadata(trackId)
      .then((metadata) => {
        if (cancelled) return;
        setCues(metadata.cues);
        setMetadataTrackId(trackId);
        setError(null);
        if (metadata.bpm !== null) {
          window.dispatchEvent(new CustomEvent("olooper:track-bpm", {
            detail: { trackId, bpm: metadata.bpm, source: metadata.bpm_source, confidence: metadata.bpm_confidence } satisfies import("../tauri").TrackBpmUpdate,
          }));
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(`Cannot read CUEs from audio file: ${String(cause)}`);
      });
    return () => { cancelled = true; };
  }, [trackId, trackOpenGeneration, st?.generation, st?.path, st?.loaded, matchesPlayback]);

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrubRef.current || !st?.loaded || st.loading || !matchesPlayback || st.duration_ms <= 0) return;
    const rect = scrubRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    playerSeek(Math.round(frac * st.duration_ms)).catch((e) => setError(String(e)));
  };

  const onScrubDown = (e: React.MouseEvent<HTMLDivElement>) => {
    setIsScrubbing(true);
    scrub(e);
  };

  useEffect(() => {
    if (!isScrubbing) return;
    const owner = metadataOwner.current;
    const onMove = (e: MouseEvent) => {
      if (owner !== metadataOwner.current || statusRef.current?.loading) return;
      if (!scrubRef.current || !st?.loaded || st.duration_ms <= 0) return;
      const rect = scrubRef.current.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      playerSeek(Math.round(frac * st.duration_ms)).catch(() => {});
    };
    const onUp = () => setIsScrubbing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isScrubbing, st?.loaded, st?.duration_ms]);

  const applyMetadata = (metadata: SeratoMetadata) => {
    setCues(metadata.cues);
    if (metadata.bpm !== null && trackId !== null) {
      window.dispatchEvent(new CustomEvent("olooper:track-bpm", {
        detail: { trackId, bpm: metadata.bpm, source: metadata.bpm_source, confidence: metadata.bpm_confidence } satisfies import("../tauri").TrackBpmUpdate,
      }));
    }
  };

  const saveCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId || st?.loading || !matchesPlayback) return;
    const cueMs = statusRef.current?.position_ms ?? 0;
    const owner = metadataOwner.current;
    librarySetSeratoCue(trackId, slot, cueMs)
      .then((metadata) => {
        if (owner !== metadataOwner.current) return;
        applyMetadata(metadata);
        setActiveCueSlot(slot);
      })
      .catch((cause) => { if (owner === metadataOwner.current) setError(String(cause)); });
  };

  const syncSeratoMetadata = useCallback(async (id: number) => {
    const owner = metadataOwner.current;
    setSeratoSyncing(true);
    setSeratoSyncError(false);
    setSeratoSyncMessage("Writing CUEs and BPM to the audio file…");
    try {
      await librarySyncSeratoMetadata(id);
      if (owner !== metadataOwner.current) return;
      setSeratoSyncMessage("Serato metadata synced. Reload this file in Serato to refresh it.");
    } catch (cause) {
      if (owner !== metadataOwner.current) return;
      setSeratoSyncError(true);
      setSeratoSyncMessage(`Data is saved in oLooper, but Serato sync failed: ${String(cause)}`);
    } finally {
      if (owner === metadataOwner.current) setSeratoSyncing(false);
    }
  }, []);

  const loadCue = (slot: number) => {
    if (metadataTrackId !== trackId || st?.loading || !matchesPlayback) return;
    const cue = cues.find((saved) => saved.slot === slot);
    if (!cue) return;
    setActiveCueSlot(slot);
    run(playerSeek(cue.position_ms));
  };

  const clearCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId || slot === 1 || st?.loading || !matchesPlayback) return;
    const owner = metadataOwner.current;
    librarySetSeratoCue(trackId, slot, null)
      .then((metadata) => {
        if (owner !== metadataOwner.current) return;
        applyMetadata(metadata);
        if (activeCueSlot === slot) setActiveCueSlot(null);
      })
      .catch((cause) => { if (owner === metadataOwner.current) setError(String(cause)); });
  };

  const applyManualLoop = () => {
    const start = Number(loopStart);
    const end = Number(loopEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError("Loop boundaries must be valid times in milliseconds.");
      return;
    }
    run(playerSetLoopSnapped(start, end, statusRef.current?.generation));
  };

  const detectLoop = () => {
    const owner = metadataOwner.current;
    const generation = statusRef.current?.generation;
    run(playerAutoLoop().then((result) => {
      if (owner !== metadataOwner.current) throw new Error("Track changed during analysis");
      if (!result.candidate) throw new Error("No suitable loop found");
      return playerSetLoopSnapped(
        Math.round(result.candidate.start_frame * 1000 / result.sample_rate),
        Math.round(result.candidate.end_frame * 1000 / result.sample_rate),
        generation,
      );
    }));
  };

  useEffect(() => {
    const handleCueShortcut = (event: Event) => {
      const { slot, clear } = (event as CustomEvent<{ slot: number; clear: boolean }>).detail;
      if (!trackId || !st?.loaded || st.loading || !matchesPlayback || !Number.isInteger(slot) || slot < 1 || slot > 4) return;
      if (audioStorage === "embedded" && slot !== 1) return;
      if (slot === 1) {
        loadCue(1);
      } else if (clear) {
        clearCue(slot);
      } else if (metadataTrackId !== trackId) {
        return;
      } else if (cues.some((cue) => cue.slot === slot)) {
        loadCue(slot);
      } else {
        saveCue(slot);
      }
    };
    window.addEventListener("olooper:cue-shortcut", handleCueShortcut);
    return () => window.removeEventListener("olooper:cue-shortcut", handleCueShortcut);
  }, [audioStorage, trackId, st?.loaded, metadataTrackId, cues, clearCue, loadCue, saveCue]);

  const posFrac = st?.loaded && st.duration_ms > 0 ? st.position_ms / st.duration_ms : 0;
  const loaded = (st?.loaded ?? false) && !st?.loading && matchesPlayback;
  const playing = st?.playing ?? false;
  // Async job errors arrive via status polling, not via the invoke that
  // started them; surface them in the same slot as command errors.
  const shownError = error ?? st?.pitch_error ?? null;

  return (
    <div className="mx-3 mb-3 flex shrink-0 flex-col gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 shadow-lg">
      {/* Scrub bar */}
      <div
        ref={scrubRef}
        role="slider"
        tabIndex={loaded ? 0 : -1}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={st?.duration_ms ?? 0}
        aria-valuenow={st?.position_ms ?? 0}
        aria-disabled={!loaded}
        onKeyDown={(event) => {
          if (!loaded) return;
          const position = st?.position_ms ?? 0;
          const target = event.key === "Home" ? 0 : event.key === "End" ? st?.duration_ms ?? 0
            : event.key === "ArrowLeft" ? position - 1000 : event.key === "ArrowRight" ? position + 1000 : null;
          if (target !== null) { event.preventDefault(); event.stopPropagation(); run(playerSeek(Math.max(0, Math.min(st?.duration_ms ?? 0, target)))); }
        }}
        onMouseDown={onScrubDown}
        className={`relative h-2 overflow-hidden rounded-full cursor-pointer group ${loaded ? "bg-border" : "bg-border/50"}`}
      >
        {loaded && (
          <svg
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-hidden pointer-events-none"
            aria-hidden="true"
          >
            <line
              x1="0"
              y1="5"
              x2={posFrac * 100}
              y2="5"
              className="stroke-accent"
              strokeWidth="10"
              strokeLinecap="round"
            />
            <circle
              cx={posFrac * 100}
              cy="5"
              r="4"
              className="fill-accent opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </svg>
        )}
      </div>

      {/* Transport row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Transport buttons */}
        <div className="flex items-center gap-1">
          <TransportBtn onClick={() => run(playerPlay())} disabled={!loaded} active={playing} title="Play (Space)">
            <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
              <polygon points="4,2 14,8 4,14" />
            </svg>
          </TransportBtn>
          <TransportBtn onClick={() => run(playerPause())} disabled={!playing} title="Pause (Space)">
            <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
              <rect x="3" y="2" width="3.5" height="12" />
              <rect x="9.5" y="2" width="3.5" height="12" />
            </svg>
          </TransportBtn>
          <TransportBtn onClick={() => run(playerStop())} disabled={!loaded} title="Stop (S)">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-current">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </TransportBtn>
          <TransportBtn onClick={onPreviousTrack} disabled={!loaded || !canNavigateTracks} title="Previous loop">
            <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
              <polygon points="11,2 3,8 11,14" />
              <rect x="12" y="2" width="1.5" height="12" />
            </svg>
          </TransportBtn>
          <TransportBtn onClick={onNextTrack} disabled={!loaded || !canNavigateTracks} title="Next loop">
            <svg viewBox="0 0 16 16" className="w-4 h-4 fill-current">
              <polygon points="5,2 13,8 5,14" />
              <rect x="2.5" y="2" width="1.5" height="12" />
            </svg>
          </TransportBtn>
          <TransportBtn onClick={() => void playNextRandom()} disabled={!canRandom} title="Next random loop (R)">
            <span className="text-[11px] font-bold">R</span>
          </TransportBtn>
        </div>

        <div className="w-px h-5 bg-border" />

        {/* Time display */}
        <div className="font-mono text-xs text-text-secondary tabular-nums min-w-[80px]">
          {st?.loading ? (
            <span className="text-warning">Loading audio…</span>
          ) : loaded ? (
            <span>
              <span className="text-text">{fmt(st!.position_ms)}</span>
              <span className="mx-1">/</span>
              {fmt(st!.duration_ms)}
            </span>
          ) : (
            <span className="text-text-secondary/40">--:--.--</span>
          )}
        </div>

        <div className="w-px h-5 bg-border" />

        {/* Volume */}
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-text-secondary shrink-0">
            <path d="M2 5.5h2.5L8 2.5v11l-3.5-3H2a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z" />
            {(st?.volume_pct ?? 80) > 0 && (
              <path d="M10 5.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-text-secondary" />
            )}
            {(st?.volume_pct ?? 80) > 50 && (
              <path d="M11.5 3.5a6 6 0 010 9" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-text-secondary" />
            )}
          </svg>
          <input
            type="range"
            min={0}
            max={100}
            value={st?.volume_pct ?? 80}
            onChange={(e) => run(playerSetVolume(Number(e.target.value)))}
            aria-label="Volume"
            className="w-16"
          />
        </div>

         <div className="w-px h-5 bg-border" />

         <div className="flex items-center gap-1">
            <span className="mr-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">Pitch</span>
            <button onClick={() => run(playerSetSpeed(Math.max(50, (st?.speed_pct ?? 100) - 5)))} disabled={!loaded} title="Slower" className="rounded bg-border px-1.5 py-0.5 text-xs text-text-secondary hover:text-text disabled:opacity-30">−</button>
            <span className="w-9 text-center font-mono text-[10px] text-text-secondary">{Math.round(st?.speed_pct ?? 100)}%</span>
            <button onClick={() => run(playerSetSpeed(Math.min(200, (st?.speed_pct ?? 100) + 5)))} disabled={!loaded} title="Faster" className="rounded bg-border px-1.5 py-0.5 text-xs text-text-secondary hover:text-text disabled:opacity-30">+</button>
          </div>

          <div className="w-px h-5 bg-border" />

          {loaded && trackId && (
            <div className="flex items-center gap-1">
                <span className="mr-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">CUE</span>
                {CUE_SLOTS.map((slot) => {
                  const cue = cues.find((saved) => saved.slot === slot);
                  const ready = metadataTrackId === trackId && loaded;
                  return (
                    <span key={slot} className="flex items-center">
                      <button
                        onClick={() => cue ? loadCue(slot) : saveCue(slot)}
                        disabled={!ready || (audioStorage === "embedded" && slot !== 1)}
                        title={slot === 1 ? "CUE 1 is fixed at the start of the track" : audioStorage === "embedded" ? "Source-backed audio only has CUE 1" : cue ? `Jump to CUE ${slot}` : `Save CUE ${slot} at the current position`}
                        className={`w-6 h-6 rounded text-[10px] font-bold transition-colors disabled:opacity-40 ${
                          activeCueSlot === slot
                            ? "bg-accent text-app"
                            : cue
                              ? "bg-success/20 text-success hover:bg-success/30"
                              : "bg-border text-text-secondary hover:bg-border hover:text-text"
                        }`}
                      >{slot}</button>
                      {cue && slot > 1 && <button onClick={() => clearCue(slot)} title={`Clear CUE ${slot}`} aria-label={`Clear CUE ${slot}`} className="-ml-1 rounded px-1 text-[10px] text-text-secondary hover:bg-danger/10 hover:text-danger">×</button>}
                    </span>
                  );
                })}
                {audioStorage === "extracted" && <button
                  onClick={() => void syncSeratoMetadata(trackId)}
                  disabled={metadataTrackId !== trackId || seratoSyncing}
                  title="Write CUEs and BPM into this audio file"
                  className="ml-1 rounded bg-accent/15 px-2 py-1 text-[9px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                >{seratoSyncing ? "Sync…" : "Audio tags"}</button>}
            </div>
          )}

        <button
          onClick={onToggleLoopEditing}
          aria-expanded={loopEditing}
          aria-controls="loop-edit-controls"
          disabled={!loaded}
          title={loopEditing ? "Hide loop editing controls" : "Show loop editing controls"}
          className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-30 ${loopEditing ? "bg-accent/20 text-accent" : "bg-border text-text-secondary hover:text-text"}`}
        >{loopEditing ? "Loop controls ▲" : "Loop controls ▼"}</button>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setRandomEnabled((enabled) => !enabled)}
            disabled={!canRandom || (!randomEnabled && !validInterval)}
            aria-pressed={randomEnabled}
            title="Change at the loop ending closest to this interval; manual Random remains immediate"
            className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-30 ${randomEnabled ? "bg-success/20 text-success" : "bg-border text-text-secondary hover:text-text"}`}
          >
            {randomEnabled ? "Random ON" : "Random OFF"}
          </button>
          <select
            aria-label="Random track interval"
            value={randomInterval}
            onChange={(event) => setRandomInterval(event.target.value as "2" | "5" | "custom")}
            className="rounded border border-border bg-elevated px-1.5 py-1 text-[10px] text-text"
          >
            <option value="2">2 min</option>
            <option value="5">5 min</option>
            <option value="custom">Custom</option>
          </select>
          {randomInterval === "custom" && (
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={customMinutes}
              onChange={(event) => setCustomMinutes(event.target.value)}
              aria-label="Custom random interval in minutes"
              className="w-12 rounded border border-border bg-elevated px-1.5 py-1 text-center text-[10px] text-text"
            />
          )}
          {randomEnabled && randomRemaining !== null && (
            <span className="min-w-8 font-mono text-[10px] tabular-nums text-success" aria-live="polite">
              {Math.floor(randomRemaining / 60)}:{String(randomRemaining % 60).padStart(2, "0")}
            </span>
          )}
        </div>

        <div className="flex-1" />
      </div>
      {loopEditing && (
        <div id="loop-edit-controls" className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
          <button
            onClick={() => run(playerSetLoopEnabled(!st?.loop_enabled))}
            disabled={!loaded}
            aria-pressed={st?.loop_enabled ?? false}
            className={`rounded px-2 py-1 text-[10px] font-medium disabled:opacity-40 ${st?.loop_enabled ? "bg-success/20 text-success" : "bg-border text-text-secondary hover:text-text"}`}
          >{st?.loop_enabled ? "LOOP ON" : "LOOP OFF"}</button>
          <button
            onClick={detectLoop}
            disabled={!loaded}
            className="rounded bg-border px-2 py-1 text-[10px] text-text-secondary hover:text-text disabled:opacity-40"
          >AUTO</button>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            Start
            <input
              ref={loopStartRef}
              type="number"
              min={0}
              max={st?.duration_ms ?? 0}
              value={loopStart}
              onChange={(event) => setLoopStart(event.target.value)}
              disabled={!loaded}
              aria-label="Loop start in milliseconds"
              className="w-20 rounded border border-border bg-elevated px-1.5 py-1 text-center font-mono text-text disabled:opacity-40"
            />
            ms
          </label>
          <span className="text-[10px] text-text-secondary">–</span>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            End
            <input
              ref={loopEndRef}
              type="number"
              min={0}
              max={st?.duration_ms ?? 0}
              value={loopEnd}
              onChange={(event) => setLoopEnd(event.target.value)}
              disabled={!loaded}
              aria-label="Loop end in milliseconds"
              className="w-20 rounded border border-border bg-elevated px-1.5 py-1 text-center font-mono text-text disabled:opacity-40"
            />
            ms
          </label>
          <button
            onClick={applyManualLoop}
            disabled={!loaded}
            className="rounded bg-accent/15 px-2.5 py-1 text-[10px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
          >Apply</button>
          <span className="text-[10px] text-text-secondary">Drag a loop edge on the waveform to adjust it.</span>
        </div>
      )}
      {(shownError || seratoSyncMessage) && (
        <div className="flex flex-col gap-1 border-t border-border pt-2 text-[11px] leading-relaxed break-words">
          {shownError && <p className="text-danger" role="alert">{shownError}</p>}
          {seratoSyncMessage && (
            <p className={seratoSyncError ? "text-danger" : "text-success"} role="status">
              {seratoSyncMessage}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TransportBtn({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
        active
          ? "bg-accent/20 text-accent"
          : "bg-border/50 text-text-secondary hover:bg-border hover:text-text"
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}
