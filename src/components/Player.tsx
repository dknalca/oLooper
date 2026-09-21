import { useCallback, useEffect, useRef, useState } from "react";
import {
  libraryGetSlots,
  libraryDeleteSlot,
  librarySetSlot,
  playerAutoLoop,
  playerPause,
  playerPlay,
  playerSeek,
  playerSetLoopSnapped,
  playerSetLoopEnabled,
  playerSetSpeed,
  playerSetPitchLock,
  playerSetVolume,
  playerStatus,
  playerStop,
  type LoopSlot,
  type PlayerStatus,
} from "../tauri";
import { exposePlayerState } from "../hooks/useKeyboardShortcuts";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(
    Math.floor((ms % 1000) / 100),
  )}`;
}

const SLOT_LABELS = ["1", "2", "3", "4"];

interface Props {
  status: PlayerStatus | null;
  trackId: number | null;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Player({ status: st, trackId, onStatusChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loopStart, setLoopStart] = useState("0");
  const [loopEnd, setLoopEnd] = useState("");
  const loopStartRef = useRef<HTMLInputElement>(null);
  const loopEndRef = useRef<HTMLInputElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);

  // Preferences are applied after a track becomes ready. Deps include the
  // path (not just `loaded`) because background track swaps keep `loaded`
  // true while changing the underlying audio.
  useEffect(() => {
    if (!st?.loaded || st.loading) return;
    const speed = Number(localStorage.getItem("olooper.player.speed"));
    const pitchLock = localStorage.getItem("olooper.player.pitch-lock");
    if (Number.isFinite(speed) && speed >= 50 && speed <= 200 && speed !== st.speed_pct) run(playerSetSpeed(speed));
    if (pitchLock !== null && (pitchLock === "true") !== st.pitch_lock) run(playerSetPitchLock(pitchLock === "true"));
  }, [st?.loaded, st?.loading, st?.path]);

  useEffect(() => {
    if (!st?.loaded) return;
    localStorage.setItem("olooper.player.speed", String(st.speed_pct));
    localStorage.setItem("olooper.player.pitch-lock", String(st.pitch_lock));
  }, [st?.loaded, st?.speed_pct, st?.pitch_lock]);

  // Loop slots
  const [slots, setSlots] = useState<LoopSlot[]>([]);
  const [activeSlot, setActiveSlot] = useState<number>(1);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<LoopSlot[]>("olooper:cues", { detail: slots }));
  }, [slots]);

  const run = useCallback(
    (p: Promise<PlayerStatus>) =>
      p.then((s) => {
        onStatusChange(s);
        setError(null);
        const active = document.activeElement;
        if (active !== loopStartRef.current && active !== loopEndRef.current) {
          setLoopStart(String(s.loop_start_ms));
          setLoopEnd(String(s.loop_end_ms));
        }
      }).catch((e) => setError(String(e))),
    [onStatusChange],
  );

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
        loop_start_ms: st.loop_start_ms,
        loop_end_ms: st.loop_end_ms,
      });
    }
  }, [st]);

  // Load slots when trackId changes.
  useEffect(() => {
    if (!trackId) {
      setSlots([]);
      return;
    }
    libraryGetSlots(trackId).then((saved) => {
      setSlots(saved.filter((slot) => slot.slot > 1 && slot.enabled));
    }).catch(() => setSlots([]));
  }, [trackId, run]);

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

  const saveToSlot = (slot: number) => {
    if (!trackId) return;
    const label = SLOT_LABELS[slot - 1];
    const cueMs = st?.position_ms ?? 0;
    const startMs = st?.loop_start_ms ?? 0;
    const endMs = st?.loop_end_ms ?? 0;
    librarySetSlot(trackId, slot, label, cueMs, startMs, endMs, true)
      .then((saved) => {
        setSlots((prev) => {
          const idx = prev.findIndex((s) => s.slot === slot);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = saved;
            return next;
          }
          return [...prev, saved];
        });
      })
      .catch((e) => setError(String(e)));
  };

  const loadSlot = (slot: number) => {
    const s = slots.find((sl) => sl.slot === slot);
    if (!s) return;
    setActiveSlot(slot);
    run(playerSeek(s.cue_ms));
  };

  const clearSlot = (slot: number) => {
    if (!trackId || slot === 1) return;
    libraryDeleteSlot(trackId, slot).then(() => {
      setSlots((current) => current.filter((item) => item.slot !== slot));
      if (activeSlot === slot) setActiveSlot(1);
    }).catch((e) => setError(String(e)));
  };

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
            <button onClick={() => run(playerSetPitchLock(!st?.pitch_lock))} disabled={!loaded} title={st?.pitch_preparing ? "Preparing pitch lock… (click to cancel)" : "Keep pitch while changing speed"} className={`rounded px-1.5 py-0.5 text-[9px] ${st?.pitch_preparing ? "bg-warning/20 text-warning" : st?.pitch_lock ? "bg-success/20 text-success" : "bg-border text-text-secondary"}`}>{st?.pitch_preparing ? "PITCH …" : "PITCH LOCK"}</button>
            {st?.pitch_preparing && (
              <span className="text-[10px] text-warning">Preparing pitch lock…</span>
            )}
         </div>

         <div className="w-px h-5 bg-border" />

         {/* Loop controls */}
        {loaded && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => run(playerSetLoopEnabled(!st!.loop_enabled))}
              title="Toggle loop (L)"
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                st!.loop_enabled
                  ? "bg-success/20 text-success"
                  : "bg-border text-text-secondary hover:text-text"
              }`}
            >
              LOOP
            </button>
            <button
              onClick={() => run(playerAutoLoop().then((r) => {
                if (r.candidate) {
                  return playerSetLoopSnapped(
                    Math.round(r.candidate.start_frame * 1000 / r.sample_rate),
                    Math.round(r.candidate.end_frame * 1000 / r.sample_rate),
                  );
                }
                return Promise.reject(new Error("No suitable loop found"));
              }))}
              title="Auto-detect loop from audio"
              className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary hover:text-text transition-colors"
            >
              AUTO
            </button>
            {st!.loop_enabled && st!.loop_origin && (
              <span
                title={`Origin: ${st!.loop_origin} · Quality: ${Math.round(st!.loop_quality * 100)}%`}
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  st!.loop_quality >= 0.7 ? "bg-success" : st!.loop_quality >= 0.3 ? "bg-warning" : "bg-danger"
                }`}
              />
            )}
            {st!.loop_enabled && (
              <>
                <input
                  ref={loopStartRef}
                  aria-label="Loop start ms"
                  value={loopStart}
                  onChange={(e) => setLoopStart(e.target.value)}
                  className="bg-elevated border border-border rounded px-1.5 py-0.5 text-[10px] font-mono w-14 text-text text-center"
                />
                <span className="text-text-secondary text-[10px]">–</span>
                <input
                  ref={loopEndRef}
                  aria-label="Loop end ms"
                  value={loopEnd}
                  onChange={(e) => setLoopEnd(e.target.value)}
                  className="bg-elevated border border-border rounded px-1.5 py-0.5 text-[10px] font-mono w-14 text-text text-center"
                />
                <button
                  onClick={() => run(playerSetLoopSnapped(Number(loopStart), Number(loopEnd)))}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary hover:text-text transition-colors"
                >
                  Set
                </button>
              </>
            )}
          </div>
        )}

        <div className="w-px h-5 bg-border" />

          {/* Cue selector */}
        {loaded && trackId && (
          <div className="flex items-center gap-1">
            {SLOT_LABELS.map((label, i) => {
              const slotNum = i + 1;
              const hasData = slotNum === 1 || slots.some((s) => s.slot === slotNum);
              const isActive = activeSlot === slotNum;
              return (
                <span key={label} className="flex items-center">
                <button
                  onClick={() => {
                    setActiveSlot(slotNum);
                    if (slotNum === 1) {
                      run(playerSeek(0));
                    } else if (hasData) {
                      loadSlot(slotNum);
                    } else {
                      saveToSlot(slotNum);
                    }
                  }}
                  title={hasData ? `Jump to cue ${label}` : `Set cue ${label} at current position`}
                  className={`w-6 h-6 rounded text-[10px] font-bold transition-colors ${
                    isActive
                      ? "bg-accent text-app"
                      : hasData
                        ? "bg-success/20 text-success hover:bg-success/30"
                        : "bg-border text-text-secondary hover:bg-border hover:text-text"
                  }`}
                >
                  {label}
                </button>
                {slotNum > 1 && hasData && <button onClick={() => clearSlot(slotNum)} title={`Clear cue ${label}`} aria-label={`Clear cue ${label}`} className="-ml-1 rounded px-1 text-[10px] text-text-secondary hover:bg-danger/10 hover:text-danger">×</button>}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex-1" />

        {shownError && (
          <span className="text-[10px] text-danger truncate max-w-64" role="alert">{shownError}</span>
        )}
      </div>
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
