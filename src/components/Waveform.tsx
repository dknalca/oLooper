import { useEffect, useRef, useState } from "react";
import {
  playerSeek,
  playerSetLoopSnapped,
  playerWaveformPeaks,
  type PlayerStatus,
  type LoopSlot,
  type WaveformData,
} from "../tauri";
import Logo from "./Logo";

interface Props {
  refreshKey: number;
  status: PlayerStatus | null;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Waveform({ refreshKey, status, onStatusChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const waveRef = useRef<WaveformData | null>(null);
  const cuesRef = useRef<LoopSlot[]>([]);
  const zoomRef = useRef(1);
  const previewRef = useRef<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [, setDragRevision] = useState(0);
  const loadedPath = status?.path ?? null;

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => {
    const setCues = (event: Event) => { cuesRef.current = (event as CustomEvent<LoopSlot[]>).detail; };
    window.addEventListener("olooper:cues", setCues);
    return () => window.removeEventListener("olooper:cues", setCues);
  }, []);

  // (Re)compute peaks once per loaded path. Delayed until the new audio
  // is actually ready: while the backend reports `loading`, `loadedPath`
  // still points at the previous track, so fetching now would only feed a
  // job the backend is about to discard.
  useEffect(() => {
    if (!loadedPath || status?.loading) {
      if (!loadedPath) waveRef.current = null;
      return;
    }
    let cancelled = false;
    // Let selection and audio playback paint before starting the second decode.
    const timer = window.setTimeout(() => {
      const width = wrapRef.current?.clientWidth ?? 800;
      // A zoomed view needs proportionally more source peaks; otherwise it
      // magnifies one coarse bucket into a blocky waveform.
      const density = window.devicePixelRatio || 1;
      const buckets = Math.min(8192, Math.max(256, Math.ceil(width * density * zoom)));
      setGenerating(true);
      playerWaveformPeaks(loadedPath, buckets)
        .then((w) => {
          if (cancelled) return;
          waveRef.current = w;
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          // Stale-job discard ("track changed …"): a newer job owns this
          // path, or the previous peaks are still valid — never a sticky
          // error.
          if (String(e).includes("track changed")) return;
          setError(String(e));
        })
        .finally(() => {
          if (!cancelled) setGenerating(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      setGenerating(false);
      window.clearTimeout(timer);
    };
  }, [loadedPath, status?.loading, refreshKey, zoom]);

  // Render loop: interpolate between polls while playing.
  useEffect(() => {
    let raf = 0;
    let lastPoll = performance.now();
    let lastPos = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const st = statusRef.current;
      const wave = waveRef.current;
      if (!canvas || !st?.loaded || !wave || wave.peaks.length === 0) return;
      if (st.position_ms !== lastPos) {
        lastPos = st.position_ms;
        lastPoll = performance.now();
      }
      const pos = st.playing
        ? lastPos + (performance.now() - lastPoll)
        : lastPos;
        render(canvas, wave, st, pos, cuesRef.current, zoomRef.current, previewRef.current);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const timeAtPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const st = statusRef.current;
    const wave = waveRef.current;
    if (!canvas || !st?.loaded || !wave) return null;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoomRef.current));
    const start = windowStart(st.position_ms, wave.duration_ms, view);
    return Math.round(start + frac * view);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const time = timeAtPointer(e);
    const st = statusRef.current;
    const wave = waveRef.current;
    const canvas = canvasRef.current;
    if (time === null || !st || !wave || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoomRef.current));
    const start = windowStart(st.position_ms, wave.duration_ms, view);
    const xOf = (ms: number) => ((ms - start) / view) * rect.width;
    const x = e.clientX - rect.left;
    const boundary = Math.abs(x - xOf(st.loop_start_ms)) <= 10 ? "start" : Math.abs(x - xOf(st.loop_end_ms)) <= 10 ? "end" : null;
    if (!boundary) { playerSeek(time).catch((err) => setError(String(err))); return; }
    canvas.setPointerCapture(e.pointerId);
    previewRef.current = { start: st.loop_start_ms, end: st.loop_end_ms };
    setDragging(boundary);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const time = timeAtPointer(e);
    if (time === null) return;
    const preview = previewRef.current;
    if (dragging === "start") preview.start = Math.min(time, preview.end - 1);
    else preview.end = Math.max(time, preview.start + 1);
    previewRef.current = { ...preview };
    setDragRevision((value) => value + 1);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const preview = previewRef.current;
    previewRef.current = null;
    setDragging(null);
    canvasRef.current?.releasePointerCapture(e.pointerId);
    playerSetLoopSnapped(preview.start, preview.end).then(onStatusChange).catch((err) => setError(String(err)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-elevated">
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <div className="absolute right-2 top-2 z-10 flex gap-1">
          <button onClick={() => setZoom((value) => Math.max(1, value / 2))} className="rounded bg-elevated px-2 py-1 text-xs text-text">-</button>
          <button onClick={() => setZoom((value) => Math.min(32, value * 2))} className="rounded bg-elevated px-2 py-1 text-xs text-text">+</button>
          <button onClick={() => setZoom(1)} className="rounded bg-elevated px-2 py-1 text-[10px] text-text">Fit</button>
        </div>
        {!loadedPath && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-text-secondary/50 pointer-events-none">
            <Logo className="h-12 w-12 opacity-50" />
            <span>Double-click a track to see its waveform</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="h-full w-full cursor-crosshair bg-[#0e0e0e]"
        />
        {generating && (
          <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-elevated/90 px-2 py-0.5 text-[10px] text-warning">
            Generating waveform…
          </div>
        )}
      </div>
      {error && (
        <div className="px-3 py-1 text-[10px] text-danger border-t border-border" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function windowStart(posMs: number, durationMs: number, viewMs: number): number {
  if (durationMs <= viewMs) return 0;
  return Math.min(Math.max(0, posMs - viewMs / 2), durationMs - viewMs);
}

function render(
  canvas: HTMLCanvasElement,
  wave: WaveformData,
  st: PlayerStatus,
  posMs: number,
  cues: LoopSlot[],
  zoom: number,
  preview: { start: number; end: number } | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoom));
  const start = windowStart(posMs, wave.duration_ms, view);
  const xOf = (t: number) => ((t - start) / view) * width;
  const peakAt = (t: number) =>
    wave.peaks[Math.min(wave.peaks.length - 1, Math.floor((t / wave.duration_ms) * wave.peaks.length))];

  // Loop region shade.
  if (st.loop_enabled) {
    const x0 = Math.max(0, xOf(preview?.start ?? st.loop_start_ms));
    const x1 = Math.min(width, xOf(preview?.end ?? st.loop_end_ms));
    ctx.fillStyle = "rgba(52, 211, 153, 0.12)";
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), height);
    // Loop edge lines
    ctx.strokeStyle = "rgba(52, 211, 153, 0.3)";
    ctx.lineWidth = 1;
    if (x0 >= 0 && x0 <= width) {
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, height);
      ctx.stroke();
    }
    if (x1 >= 0 && x1 <= width) {
      ctx.beginPath();
      ctx.moveTo(x1, 0);
      ctx.lineTo(x1, height);
      ctx.stroke();
    }
  }

  // Bars.
  const mid = height / 2;
  const step = Math.max(1, Math.floor(width / wave.peaks.length / 2));
  for (let x = 0; x < width; x += step) {
    const t = start + (x / width) * view;
    const h = Math.max(1, peakAt(t) * (mid - 4));
    const played = t <= posMs;
    ctx.fillStyle = played ? "#4aa3ff" : "#1e3a54";
    ctx.fillRect(x, mid - h, Math.max(1, step - 1), h * 2);
  }

  // Cue 1 is fixed at the track start; optional cues are saved per track.
  [{ slot: 1, cue_ms: 0 }, ...cues].forEach((cue) => {
    const cx = xOf(cue.cue_ms);
    if (cx < 0 || cx > width) return;
    ctx.fillStyle = cue.slot === 1 ? "#fbbf24" : "#f97316";
    ctx.fillRect(cx - 1, 0, 2, height);
    ctx.font = "10px sans-serif";
    ctx.fillText(String(cue.slot), cx + 3, 11);
  });

  // Fixed playhead.
  const px = xOf(Math.min(posMs, wave.duration_ms));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, height);
}
