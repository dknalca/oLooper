import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { PlayerStatus, SeratoCue, WaveformData } from "../tauri";
import { renderWaveform } from "../waveformRender";
import { createWaveformAnimation } from "../waveformAnimation";

interface Options {
  paused?: boolean;
  canvasRef: RefObject<HTMLCanvasElement>;
  statusRef: RefObject<PlayerStatus | null>;
  waveRef: RefObject<WaveformData | null>;
  waveTrackIdRef: RefObject<number | null>;
  wavePathRef: RefObject<string | null>;
  trackIdRef: RefObject<number | null>;
  cuesRef: RefObject<SeratoCue[]>;
  zoomRef: RefObject<number>;
  previewRef: RefObject<{ start: number; end: number } | null>;
  loopEditingRef: RefObject<boolean>;
}

/** Native playback is independent: only the visual animation is suspended. */
export function useWaveformDrawing({ paused = false, canvasRef, statusRef, waveRef, waveTrackIdRef, wavePathRef, trackIdRef, cuesRef, zoomRef, previewRef, loopEditingRef }: Options) {
  const invalidate = useRef(() => {});
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const redraw = useCallback(() => invalidate.current(), []);
  useEffect(() => {
    let lastPoll = 0;
    let lastPos = -1;
    let lastOwner = "";
    let lastPlaying = false;
    let lastSpeed = 1;
    let lastInputs: unknown[] = [];
    const animation = createWaveformAnimation((now) => {
      const canvas = canvasRef.current;
      const st = statusRef.current;
      const wave = waveRef.current;
      if (!canvas || !st?.loaded || st.loading || !wave || wave.peaks.length === 0
        || waveTrackIdRef.current !== trackIdRef.current || wavePathRef.current !== st.path) return false;
      const owner = JSON.stringify([st.path, st.generation]);
      const speed = st.pitch_lock ? 1 : st.speed_pct / 100;
      if (st.position_ms !== lastPos || owner !== lastOwner || st.playing !== lastPlaying || speed !== lastSpeed) {
        lastPos = st.position_ms;
        lastPoll = now;
        lastOwner = owner;
        lastPlaying = st.playing;
        lastSpeed = speed;
      }
      const pos = st.playing ? lastPos + (now - lastPoll) * speed : lastPos;
      const inputs = [wave, pos, st.loop_start_ms, st.loop_end_ms, st.loop_enabled,
        cuesRef.current, zoomRef.current, previewRef.current, loopEditingRef.current,
        canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio];
      if (!inputs.every((value, index) => value === lastInputs[index])) {
        lastInputs = inputs;
        renderWaveform(canvas, wave, st, pos, cuesRef.current ?? [], zoomRef.current ?? 1, previewRef.current, loopEditingRef.current ?? false);
      }
      return st.playing;
    }, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
      visible: () => !document.hidden && !pausedRef.current,
    });
    invalidate.current = animation.invalidate;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    if (canvasRef.current) resize?.observe(canvasRef.current);
    document.addEventListener("visibilitychange", redraw);
    window.addEventListener("resize", redraw);
    redraw();
    return () => {
      animation.dispose(); resize?.disconnect(); invalidate.current = () => {};
      document.removeEventListener("visibilitychange", redraw);
      window.removeEventListener("resize", redraw);
    };
  }, [canvasRef, statusRef, waveRef, waveTrackIdRef, wavePathRef, trackIdRef, cuesRef, zoomRef, previewRef, loopEditingRef, redraw]);
  useEffect(redraw, [paused, redraw]);
  return redraw;
}
