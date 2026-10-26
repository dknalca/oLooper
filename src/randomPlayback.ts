import type { PlayerStatus } from "./tauri";

export interface RandomSwitchOptions {
  atLoopEnd: boolean;
  signal?: AbortSignal;
}

/** Wall-clock distance to the closest future endpoint; ties prefer the earlier lap. */
export function nearestLoopEnd(status: PlayerStatus, desiredMs: number): { delayMs: number; periodMs: number } | null {
  const speed = status.pitch_lock ? 1 : status.speed_pct / 100;
  const span = status.loop_end_ms - status.loop_start_ms;
  if (!status.loaded || !status.playing || !Number.isFinite(desiredMs) || !Number.isFinite(speed) || speed <= 0 || !Number.isFinite(span) || span <= 0) return null;
  const periodMs = span / speed;
  const position = Math.max(status.loop_start_ms, Math.min(status.loop_end_ms, status.position_ms));
  const first = (status.loop_end_ms - position) / speed;
  const extra = status.loop_enabled ? Math.max(0, Math.ceil((desiredMs - first) / periodMs - 0.5 - 1e-9)) : 0;
  return { delayMs: first + extra * periodMs, periodMs };
}

/** The timer prepares a switch; the native source owns the actual loop endpoint. */
export function createRandomPlayback(options: {
  action: (request?: RandomSwitchOptions) => Promise<boolean | void>;
  onRemaining: (seconds: number | null) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
}) {
  let intervalMs: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let pending: { promise: Promise<void>; abort: AbortController; atLoopEnd: boolean } | null = null;
  let playback: PlayerStatus | null = null;
  let deadline = 0;
  let pausedAt: number | null = null;

  const clear = () => { clearTimeout(timeout); clearInterval(ticker); };
  const plan = () => {
    clear();
    if (intervalMs === null) { options.onRemaining(null); return; }
    if (playback?.loaded && (!playback.playing || playback.loading || playback.pitch_preparing)) {
      options.onRemaining(Math.max(0, Math.ceil((deadline - (pausedAt ?? Date.now())) / 1000)));
      return;
    }
    const nearest = playback ? nearestLoopEnd(playback, deadline - Date.now()) : null;
    const target = nearest ? Date.now() + nearest.delayMs : deadline;
    const prepareAt = target - (nearest ? Math.min(1000, nearest.periodMs / 2) : 0);
    const update = () => options.onRemaining(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    update();
    ticker = setInterval(update, 1000);
    timeout = setTimeout(() => void run(true, nearest !== null), Math.max(0, prepareAt - Date.now()));
  };
  const schedule = () => {
    deadline = Date.now() + (intervalMs ?? 0);
    pausedAt = playback?.loaded && !playback.playing ? Date.now() : null;
    plan();
  };
  const run = (automatic: boolean, atLoopEnd = false): Promise<void> => {
    if (pending) return pending.promise;
    clearTimeout(timeout);
    if (!automatic) { clear(); if (intervalMs !== null) options.onRemaining(0); }
    const operation = { promise: Promise.resolve(), abort: new AbortController(), atLoopEnd, changed: true };
    pending = operation;
    operation.promise = Promise.resolve()
      .then(() => options.action(automatic ? { atLoopEnd, signal: operation.abort.signal } : undefined))
      .then((changed) => {
        operation.changed = changed !== false;
        if (operation.changed && !operation.abort.signal.aborted) options.onSuccess();
      }, (cause) => { if (!operation.abort.signal.aborted) options.onError(cause); })
      .finally(() => {
        if (pending !== operation) return;
        pending = null;
        if (operation.abort.signal.aborted || (operation.atLoopEnd && !operation.changed)) plan();
        else schedule();
      });
    return operation.promise;
  };

  return {
    trigger(): Promise<void> {
      // Manual Random/R remains immediate, even during an armed timed change.
      if (pending?.atLoopEnd) { pending.abort.abort(); pending = null; }
      return run(false);
    },
    configure(nextIntervalMs: number | null) {
      intervalMs = nextIntervalMs;
      deadline = Date.now() + (intervalMs ?? 0);
      pausedAt = playback?.loaded && !playback.playing ? Date.now() : null;
      clear();
      if (pending?.atLoopEnd) pending.abort.abort();
      if (!pending) schedule();
      else options.onRemaining(intervalMs === null ? null : 0);
    },
    updatePlayback(next: PlayerStatus | null) {
      const previous = playback;
      playback = next;
      if (intervalMs === null) return;
      if (next?.loaded && !next.playing) {
        pausedAt ??= Date.now();
      } else if (pausedAt !== null) {
        deadline += Date.now() - pausedAt;
        pausedAt = null;
      }
      if (pending) {
        const sameTrack = previous?.generation === next?.generation && previous?.path === next?.path;
        if (pending.atLoopEnd && sameTrack && next && (!next.playing || next.speed_pct !== previous?.speed_pct || next.pitch_lock !== previous?.pitch_lock || next.loop_start_ms !== previous?.loop_start_ms || next.loop_end_ms !== previous?.loop_end_ms || next.loop_enabled !== previous?.loop_enabled)) {
          pending.abort.abort();
        }
        return;
      }
      if (next?.loaded && (previous?.generation !== next.generation || previous?.path !== next.path)) {
        schedule();
      } else { plan(); }
    },
  };
}
