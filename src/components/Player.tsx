import { useCallback, useEffect, useRef, useState } from "react";
import { startPlayerStatusPolling } from "../playerStatusPolling";
import type { RandomSwitchOptions } from "../randomPlayback";
import { useRandomPlayback } from "../hooks/useRandomPlayback";
import { usePlayerCues } from "../hooks/usePlayerCues";
import { usePlayerLoopEditor } from "../hooks/usePlayerLoopEditor";
import {
  playerPause,
  playerPlay,
  playerSetLoopEnabled,
  playerSetSpeed,
  playerSetVolume,
  playerStop,
  type PlayerStatus,
} from "../tauri";
import { exposePlayerState } from "../hooks/useKeyboardShortcuts";
import CueControls from "./CueControls";
import PlayerAudioControls from "./PlayerAudioControls";
import RandomPlaybackControls from "./RandomPlaybackControls";
import LoopEditingControls from "./LoopEditingControls";
import PlayerScrubBar from "./PlayerScrubBar";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(
    Math.floor((ms % 1000) / 100),
  )}`;
}

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
  const random = useRandomPlayback(st, canRandom, onRandomTrack, setError);

  const statusRef = useRef(st);
  const metadataOwner = useRef("");
  metadataOwner.current = `${trackId}:${trackOpenGeneration}:${st?.generation ?? 0}:${st?.path ?? ""}`;

  statusRef.current = st;

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
  const { cues, metadataTrackId, activeCueSlot, seratoSyncing, seratoSyncMessage, seratoSyncError, loadCue, saveCue, clearCue, syncSeratoMetadata } = usePlayerCues({
    trackId, trackOpenGeneration, audioStorage, status: st, matchesPlayback,
    statusRef, ownerRef: metadataOwner, setError, run,
  });
  const loop = usePlayerLoopEditor(st, statusRef, metadataOwner, setError, run);

  const playNextRandom = random.trigger;

  // Request native position at 4 Hz while playing, and also while a
  // background job (decode/stretch) is pending so progress and async
  // errors surface without new event plumbing.
  useEffect(() => {
    if (!st?.playing && !st?.loading && !st?.pitch_preparing) return;
    return startPlayerStatusPolling(() => {
      const owner = metadataOwner.current;
      return (status) => {
        if (owner === metadataOwner.current) onStatusChange(status);
      };
    }, 250, false);
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

  const loaded = (st?.loaded ?? false) && !st?.loading && matchesPlayback;
  const playing = st?.playing ?? false;
  // Async job errors arrive via status polling, not via the invoke that
  // started them; surface them in the same slot as command errors.
  const shownError = error ?? st?.pitch_error ?? null;

  return (
    <div className="mx-3 mb-3 flex shrink-0 flex-col gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 shadow-lg">
      <PlayerScrubBar status={st} matchesPlayback={matchesPlayback} loaded={loaded} statusRef={statusRef}
        ownerRef={metadataOwner} setError={setError} run={run} />

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

        <PlayerAudioControls status={st} loaded={loaded} onVolume={(value) => run(playerSetVolume(value))}
          onSpeed={(value) => run(playerSetSpeed(value))} />

          <div className="w-px h-5 bg-border" />

          {loaded && trackId && (
            <CueControls cues={cues} ready={metadataTrackId === trackId && loaded} audioStorage={audioStorage}
              activeCueSlot={activeCueSlot} syncing={seratoSyncing} onLoad={loadCue} onSave={saveCue}
              onClear={clearCue} onSync={() => void syncSeratoMetadata(trackId)} />
          )}

        <button
          onClick={onToggleLoopEditing}
          aria-expanded={loopEditing}
          aria-controls="loop-edit-controls"
          disabled={!loaded}
          title={loopEditing ? "Hide loop editing controls" : "Show loop editing controls"}
          className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-30 ${loopEditing ? "bg-accent/20 text-accent" : "bg-border text-text-secondary hover:text-text"}`}
        >{loopEditing ? "Loop controls ▲" : "Loop controls ▼"}</button>

        <RandomPlaybackControls enabled={random.enabled} canRandom={canRandom} validInterval={random.validInterval}
          interval={random.interval} customMinutes={random.customMinutes} remaining={random.remaining}
          onToggle={() => random.setEnabled((enabled) => !enabled)} onIntervalChange={random.setInterval} onCustomMinutesChange={random.setCustomMinutes} />

        <div className="flex-1" />
      </div>
      {loopEditing && (
        <LoopEditingControls loaded={loaded} loopEnabled={st?.loop_enabled ?? false} durationMs={st?.duration_ms ?? 0}
          start={loop.start} end={loop.end} startRef={loop.startRef} endRef={loop.endRef}
          onToggleLoop={() => run(playerSetLoopEnabled(!st?.loop_enabled))} onDetect={loop.detect}
          onStartChange={loop.setStart} onEndChange={loop.setEnd} onApply={loop.apply} />
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
