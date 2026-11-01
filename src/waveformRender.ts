import type { PlayerStatus, SeratoCue, WaveformData } from "./tauri";

export function waveformWindowStart(posMs: number, durationMs: number, viewMs: number): number {
  if (durationMs <= viewMs) return 0;
  return Math.min(Math.max(0, posMs - viewMs / 2), durationMs - viewMs);
}

/** Draw one frame; loading, playback interpolation and interaction remain outside. */
export function renderWaveform(
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
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoom));
  const start = waveformWindowStart(posMs, wave.duration_ms, view);
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
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, height); ctx.stroke();
    }
    if (x1 >= 0 && x1 <= width) {
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, height); ctx.stroke();
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
  const px = xOf(Math.min(posMs, wave.duration_ms));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px - 1, 0, 2, height);
}
