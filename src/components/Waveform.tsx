import { useEffect, useRef, useState } from "react";
import {
  playerSeek,
  playerWaveformPeaks,
  type PlayerStatus,
  type WaveformData,
} from "../tauri";
import Logo from "./Logo";

const VIEW_MS = 30_000;

interface Props {
  refreshKey: number;
  status: PlayerStatus | null;
}

export default function Waveform({ refreshKey, status }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const waveRef = useRef<WaveformData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedPath = status?.path ?? null;

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // (Re)compute peaks once per loaded path.
  useEffect(() => {
    if (!loadedPath) {
      waveRef.current = null;
      return;
    }
    let cancelled = false;
    // Let selection and audio playback paint before starting the second decode.
    const timer = window.setTimeout(() => {
      const width = wrapRef.current?.clientWidth ?? 800;
      const buckets = Math.min(2048, Math.max(64, Math.floor(width / 2)));
      playerWaveformPeaks(loadedPath, buckets)
        .then((w) => {
          if (cancelled) return;
          waveRef.current = w;
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadedPath, refreshKey]);

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
      render(canvas, wave, st, pos);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const st = statusRef.current;
    const wave = waveRef.current;
    if (!canvas || !st?.loaded || !wave) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const view = Math.min(wave.duration_ms, VIEW_MS);
    const start = windowStart(st.position_ms, wave.duration_ms, view);
    playerSeek(Math.round(start + frac * view)).catch((err) =>
      setError(String(err)),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-elevated">
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        {!loadedPath && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs text-text-secondary/50 pointer-events-none">
            <Logo className="h-12 w-12 opacity-50" />
            <span>Double-click a track to see its waveform</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          onClick={onClick}
          className="h-full w-full cursor-crosshair bg-[#0e0e0e]"
        />
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

  const view = Math.min(wave.duration_ms, VIEW_MS);
  const start = windowStart(posMs, wave.duration_ms, view);
  const xOf = (t: number) => ((t - start) / view) * width;
  const peakAt = (t: number) =>
    wave.peaks[Math.min(wave.peaks.length - 1, Math.floor((t / wave.duration_ms) * wave.peaks.length))];

  // Loop region shade.
  if (st.loop_enabled) {
    const x0 = Math.max(0, xOf(st.loop_start_ms));
    const x1 = Math.min(width, xOf(st.loop_end_ms));
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

  // Cue marker.
  const cx = xOf(st.loop_start_ms);
  if (cx >= 0 && cx <= width) {
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(cx - 1, 0, 2, 16);
  }

  // Fixed playhead.
  const px = xOf(Math.min(posMs, wave.duration_ms));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, height);
}
