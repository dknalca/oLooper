import { useCallback, useEffect, useRef, useState } from "react";
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
  trackOpenGeneration: number;
  canRandom: boolean;
  onRandomTrack: () => Promise<void>;
  canNavigateTracks: boolean;
  onPreviousTrack: () => void;
  onNextTrack: () => void;
  loopEditing: boolean;
  onToggleLoopEditing: () => void;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Player({ status: st, trackId, trackOpenGeneration, canRandom, onRandomTrack, canNavigateTracks, onPreviousTrack, onNextTrack, loopEditing, onToggleLoopEditing, onStatusChange }: Props) {
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
  const [randomResetGeneration, setRandomResetGeneration] = useState(0);
  const minutes = randomInterval === "custom" ? Number(customMinutes) : Number(randomInterval);
  const validInterval = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440;

  useEffect(() => {
    if (!randomEnabled || !canRandom || !validInterval) {
      setRandomRemaining(null);
      return;
    }
    let cancelled = false;
    let timeout = 0;
    let ticker = 0;
    const intervalMs = minutes * 60_000;
    const schedule = () => {
      const deadline = Date.now() + intervalMs;
      const update = () => setRandomRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      update();
      ticker = window.setInterval(update, 250);
      timeout = window.setTimeout(async () => {
        window.clearInterval(ticker);
        setRandomRemaining(0);
        try {
          await onRandomTrack();
          setError(null);
        } catch (reason) {
          setError(`Random track: ${String(reason)}`);
        }
        if (!cancelled) schedule();
      }, intervalMs);
    };
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearInterval(ticker);
    };
  }, [randomEnabled, canRandom, validInterval, minutes, onRandomTrack, randomResetGeneration]);

  // CUEs live in the audio file, not the private catalog DB.
  const [cues, setCues] = useState<SeratoCue[]>([]);
  const [metadataTrackId, setMetadataTrackId] = useState<number | null>(null);
  const [activeCueSlot, setActiveCueSlot] = useState<number | null>(null);
  const [seratoSyncing, setSeratoSyncing] = useState(false);
  const [seratoSyncMessage, setSeratoSyncMessage] = useState<string | null>(null);
  const [seratoSyncError, setSeratoSyncError] = useState(false);
  const statusRef = useRef(st);

  useEffect(() => { statusRef.current = st; }, [st]);

  useEffect(() => {
    setSeratoSyncMessage(null);
    setSeratoSyncError(false);
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

  const run = useCallback(
    (p: Promise<PlayerStatus>) =>
      p.then((s) => {
        onStatusChange(s);
        setError(null);
      }).catch((e) => setError(String(e))),
    [onStatusChange],
  );

  const playNextRandom = async () => {
    try {
      await onRandomTrack();
      setError(null);
      if (randomEnabled) setRandomResetGeneration((generation) => generation + 1);
    } catch (cause) {
      setError(`Random track: ${String(cause)}`);
    }
  };

  // Poll native position at 4 Hz while playing, and also while a
  // background job (decode/stretch) is pending so progress and async
  // errors surface without new event plumbing.
  useEffect(() => {
    if (!st?.playing && !st?.loading && !st?.pitch_preparing) return;
    const id = setInterval(() => playerStatus().then(onStatusChange).catch(() => {}), 250);
    return () => clearInterval(id);
  }, [st?.playing, st?.loading, st?.pitch_preparing]);

  // Expose state to keyboard shortcuts hook.
  useEffect(() => {
    if (st) {
      exposePlayerState({
        position_ms: st.position_ms,
        playing: st.playing,
        loaded: st.loaded,
        loop_enabled: st.loop_enabled,
        duration_ms: st.duration_ms,
      });
    }
  }, [st]);

  // Read markers from the audio file every time a track is opened.
  useEffect(() => {
    let cancelled = false;
    setCues([]);
    setMetadataTrackId(null);
    setActiveCueSlot(null);
    if (!trackId || !st?.loaded) {
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
            detail: { trackId, bpm: metadata.bpm },
          }));
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(`Cannot read CUEs from audio file: ${String(cause)}`);
      });
    return () => { cancelled = true; };
  }, [trackId, trackOpenGeneration, st?.path, st?.loaded]);

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!scrubRef.current || !st?.loaded || st.duration_ms <= 0) return;
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
    const onMove = (e: MouseEvent) => {
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
        detail: { trackId, bpm: metadata.bpm },
      }));
    }
  };

  const saveCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId) return;
    const cueMs = statusRef.current?.position_ms ?? 0;
    librarySetSeratoCue(trackId, slot, cueMs)
      .then((metadata) => {
        applyMetadata(metadata);
        setActiveCueSlot(slot);
      })
      .catch((cause) => setError(String(cause)));
  };

  const syncSeratoMetadata = useCallback(async (id: number) => {
    setSeratoSyncing(true);
    setSeratoSyncError(false);
    setSeratoSyncMessage("Writing CUEs and BPM to the audio file…");
    try {
      await librarySyncSeratoMetadata(id);
      setSeratoSyncMessage("Serato metadata synced. Reload this file in Serato to refresh it.");
    } catch (cause) {
      setSeratoSyncError(true);
      setSeratoSyncMessage(`Data is saved in oLooper, but Serato sync failed: ${String(cause)}`);
    } finally {
      setSeratoSyncing(false);
    }
  }, []);

  const loadCue = (slot: number) => {
    if (metadataTrackId !== trackId) return;
    const cue = cues.find((saved) => saved.slot === slot);
    if (!cue) return;
    setActiveCueSlot(slot);
    run(playerSeek(cue.position_ms));
  };

  const clearCue = (slot: number) => {
    if (!trackId || metadataTrackId !== trackId || slot === 1) return;
    librarySetSeratoCue(trackId, slot, null)
      .then((metadata) => {
        applyMetadata(metadata);
        if (activeCueSlot === slot) setActiveCueSlot(null);
      })
      .catch((cause) => setError(String(cause)));
  };

  const applyManualLoop = () => {
    const start = Number(loopStart);
    const end = Number(loopEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError("Loop boundaries must be valid times in milliseconds.");
      return;
    }
    run(playerSetLoopSnapped(start, end));
  };

  const detectLoop = () => {
    run(playerAutoLoop().then((result) => {
      if (!result.candidate) throw new Error("No suitable loop found");
      return playerSetLoopSnapped(
        Math.round(result.candidate.start_frame * 1000 / result.sample_rate),
        Math.round(result.candidate.end_frame * 1000 / result.sample_rate),
      );
    }));
  };

  useEffect(() => {
    const handleCueShortcut = (event: Event) => {
      const { slot, clear } = (event as CustomEvent<{ slot: number; clear: boolean }>).detail;
      if (!trackId || !st?.loaded || !Number.isInteger(slot) || slot < 1 || slot > 4) return;
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
  }, [trackId, st?.loaded, metadataTrackId, cues, clearCue, loadCue, saveCue]);

  const posFrac = st?.loaded && st.duration_ms > 0 ? st.position_ms / st.duration_ms : 0;
  const loaded = st?.loaded ?? false;
  const playing = st?.playing ?? false;
  // Async job errors arrive via status polling, not via the invoke that
  // started them; surface them in the same slot as command errors.
  const shownError = error ?? st?.pitch_error ?? null;

  return (
    <div className="flex flex-col gap-2 px-4 py-3 bg-surface border-t border-border">
      {/* Scrub bar */}
      <div
        ref={scrubRef}
        onMouseDown={onScrubDown}
        className={`relative h-2 rounded-full cursor-pointer group ${loaded ? "bg-border" : "bg-border/50"}`}
      >
        {loaded && (
          <svg
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible pointer-events-none"
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
      <div className="flex items-center gap-2">
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
          <TransportBtn onClick={() => void playNextRandom()} disabled={!canRandom} title="Next random loop">
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
                  const ready = metadataTrackId === trackId;
                  return (
                    <span key={slot} className="flex items-center">
                      <button
                        onClick={() => cue ? loadCue(slot) : saveCue(slot)}
                        disabled={!ready}
                        title={slot === 1 ? "CUE 1 is fixed at the start of the track" : cue ? `Jump to CUE ${slot}` : `Save CUE ${slot} at the current position`}
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
                <button
                  onClick={() => void syncSeratoMetadata(trackId)}
                  disabled={metadataTrackId !== trackId || seratoSyncing}
                  title="Write CUEs and BPM into this audio file"
                  className="ml-1 rounded bg-accent/15 px-2 py-1 text-[9px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                >{seratoSyncing ? "Sync…" : "Audio tags"}</button>
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
            title="Automatically play a random track from your local library at this interval"
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
