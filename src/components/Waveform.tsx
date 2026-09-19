import { useEffect, useRef, useState } from "react";
import {
  playerSeek,
  playerStatus,
  waveformPeaks,
  type PlayerStatus,
  type WaveformData,
} from "../tauri";

const VIEW_MS = 30_000;
const HEIGHT = 160;

export default function Waveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const waveRef = useRef<WaveformData | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);

  // Poll native position (authoritative) at 4 Hz.
  useEffect(() => {
    const id = setInterval(() => {
      playerStatus()
        .then((s) => {
          const prev = statusRef.current;
          statusRef.current = s;
          if (s.path !== prev?.path) {
            setLoadedPath(s.path);
          }
          force((n) => n + 1);
        })
        .catch(() => {});
    }, 250);
    return () => clearInterval(id);
  }, []);

  // (Re)compute peaks once per loaded path.
  useEffect(() => {
    if (!loadedPath) {
      waveRef.current = null;
      return;
    }
    const width = wrapRef.current?.clientWidth ?? 800;
    const buckets = Math.min(2048, Math.max(64, Math.floor(width / 2)));
    waveformPeaks(loadedPath, buckets)
      .then((w) => {
        waveRef.current = w;
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [loadedPath]);

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
    <section>
      <h2>Waveform</h2>
      <div ref={wrapRef}>
        <canvas
          ref={canvasRef}
          height={HEIGHT}
          style={{ width: "100%", height: HEIGHT, background: "#161616", cursor: "crosshair" }}
          onClick={onClick}
        />
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
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
  if (canvas.width !== width * dpr) {
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, HEIGHT);

  const view = Math.min(wave.duration_ms, VIEW_MS);
  const start = windowStart(posMs, wave.duration_ms, view);
  const xOf = (t: number) => ((t - start) / view) * width;
  const peakAt = (t: number) =>
    wave.peaks[Math.min(wave.peaks.length - 1, Math.floor((t / wave.duration_ms) * wave.peaks.length))];

  // Loop region shade.
  if (st.loop_enabled) {
    const x0 = Math.max(0, xOf(st.loop_start_ms));
    const x1 = Math.min(width, xOf(st.loop_end_ms));
    ctx.fillStyle = "rgba(80, 200, 120, 0.18)";
    ctx.fillRect(x0, 0, Math.max(0, x1 - x0), HEIGHT);
  }

  // Bars.
  const mid = HEIGHT / 2;
  ctx.fillStyle = "#4aa3ff";
  const step = Math.max(1, Math.floor(width / wave.peaks.length / 2));
  for (let x = 0; x < width; x += step) {
    const t = start + (x / width) * view;
    const h = Math.max(1, peakAt(t) * (mid - 4));
    const played = t <= posMs;
    ctx.fillStyle = played ? "#4aa3ff" : "#2a5a8f";
    ctx.fillRect(x, mid - h, Math.max(1, step - 1), h * 2);
  }

  // Cue marker.
  const cx = xOf(st.loop_start_ms);
  if (cx >= 0 && cx <= width) {
    ctx.fillStyle = "#ffd23f";
    ctx.fillRect(cx - 1, 0, 2, 12);
  }

  // Fixed playhead.
  const px = xOf(Math.min(posMs, wave.duration_ms));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, HEIGHT);
}
