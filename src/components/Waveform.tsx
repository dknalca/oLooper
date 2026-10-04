import { useEffect, useRef, useState } from "react";
import {
  playerSeek,
  playerSetLoopSnapped,
  playerWaveformPeaks,
  type PlayerStatus,
  type SeratoCue,
  type WaveformData,
} from "../tauri";
import Logo from "./Logo";

interface Props {
  refreshKey: number;
  status: PlayerStatus | null;
  trackTitle: string | null;
  loopEditing: boolean;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Waveform({ refreshKey, status, trackTitle, loopEditing, onStatusChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const waveRef = useRef<WaveformData | null>(null);
  const cuesRef = useRef<SeratoCue[]>([]);
  const zoomRef = useRef(1);
  const previewRef = useRef<{ start: number; end: number } | null>(null);
  const loopEditingRef = useRef(loopEditing);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; time: number } | null>(null);
  const loadedPath = status?.path ?? null;

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => {
    loopEditingRef.current = loopEditing;
    if (!loopEditing) {
      previewRef.current = null;
      setDragging(null);
    }
  }, [loopEditing]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const setCues = (event: Event) => { cuesRef.current = (event as CustomEvent<SeratoCue[]>).detail; };
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
        render(canvas, wave, st, pos, cuesRef.current, zoomRef.current, previewRef.current, loopEditingRef.current);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const timeAtPointer = (e: { clientX: number }) => {
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
    if (e.button !== 0) return;
    const time = timeAtPointer(e);
    const canvas = canvasRef.current;
    const st = statusRef.current;
    const wave = waveRef.current;
    if (time === null || !canvas || !st || !wave) return;
    if (loopEditing) {
      const rect = canvas.getBoundingClientRect();
      const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoomRef.current));
      const start = windowStart(st.position_ms, wave.duration_ms, view);
      const xOf = (ms: number) => ((ms - start) / view) * rect.width;
      const pointerX = e.clientX - rect.left;
      const startDistance = Math.abs(pointerX - xOf(st.loop_start_ms));
      const endDistance = Math.abs(pointerX - xOf(st.loop_end_ms));
      const boundary = Math.min(startDistance, endDistance) <= 12
        ? (startDistance <= endDistance ? "start" : "end")
        : null;
      if (boundary) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        previewRef.current = { start: st.loop_start_ms, end: st.loop_end_ms };
        setDragging(boundary);
        return;
      }
    }
    playerSeek(time).then(onStatusChange).catch((err) => setError(String(err)));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const time = timeAtPointer(e);
    if (time === null) return;
    const preview = { ...previewRef.current };
    if (dragging === "start") preview.start = Math.max(0, Math.min(time, preview.end - 1));
    else preview.end = Math.min(statusRef.current?.duration_ms ?? time, Math.max(time, preview.start + 1));
    previewRef.current = preview;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const preview = previewRef.current;
    previewRef.current = null;
    setDragging(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    playerSetLoopSnapped(preview.start, preview.end)
      .then(onStatusChange)
      .catch((reason: unknown) => setError(String(reason)));
  };

  const openWaveformMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const time = timeAtPointer(event);
    if (time === null) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, time });
  };

  const seekFromMenu = (time: number) => {
    setContextMenu(null);
    playerSeek(time).then(onStatusChange).catch((reason: unknown) => setError(String(reason)));
  };

  const copyTimeFromMenu = async (time: number) => {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(`${(time / 1000).toFixed(2)} s`);
    } catch (reason) {
      setError(`Could not copy time: ${String(reason)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-elevated">
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        {status?.loaded && trackTitle && (
          <div className="pointer-events-none absolute left-3 top-2 z-10 max-w-[65%] truncate rounded bg-app/75 px-2 py-1 text-[11px] font-medium text-text shadow-sm" title={trackTitle}>
            {trackTitle}
          </div>
        )}
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
          onContextMenu={openWaveformMenu}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { previewRef.current = null; setDragging(null); }}
          className={`h-full w-full bg-[#0e0e0e] ${loopEditing ? "cursor-col-resize" : "cursor-crosshair"}`}
        />
        {contextMenu && status?.loaded && (
          <div
            className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
          }}
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => seekFromMenu(contextMenu.time)} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">
              Seek to {(contextMenu.time / 1000).toFixed(2)}s
            </button>
            <button
              onClick={() => void copyTimeFromMenu(contextMenu.time)}
              className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover"
            >
              Copy time
            </button>
          </div>
        )}
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
  cues: SeratoCue[],
  zoom: number,
  preview: { start: number; end: number } | null,
  loopEditing: boolean,
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

  const loopStart = preview?.start ?? st.loop_start_ms;
  const loopEnd = preview?.end ?? st.loop_end_ms;
  if (st.loop_enabled) {
    const x0 = Math.max(0, xOf(loopStart));
    const x1 = Math.min(width, xOf(loopEnd));
    ctx.fillStyle = "rgba(52, 211, 153, 0.12)";
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), height);
  }
  if (st.loop_enabled || loopEditing) {
    const x0 = xOf(loopStart);
    const x1 = xOf(loopEnd);
    ctx.strokeStyle = loopEditing ? "rgba(74, 163, 255, 0.9)" : "rgba(52, 211, 153, 0.3)";
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
    if (loopEditing) {
      ctx.fillStyle = "#4aa3ff";
      for (const [x, label] of [[x0, "START"], [x1, "END"]] as const) {
        if (x < 0 || x > width) continue;
        ctx.fillRect(x - 3, 0, 6, 10);
        ctx.font = "9px sans-serif";
        ctx.fillText(label, Math.min(width - 32, Math.max(4, x + 5)), 19);
      }
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

  cues.forEach((cue) => {
    const cx = xOf(cue.position_ms);
    if (cx < 0 || cx > width) return;
    ctx.fillStyle = "#f97316";
    ctx.fillRect(cx - 1, 0, 2, height);
    ctx.font = "10px sans-serif";
    ctx.fillText(String(cue.slot), cx + 3, 11);
  });

  // Fixed playhead.
  const px = xOf(Math.min(posMs, wave.duration_ms));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, height);
}
