import { useEffect, useRef, useState } from "react";
import { playerSetMetronome } from "../tauri";

/** Own metronome controls, native commands and visual beat lifecycle. */
export default function MetronomeControls({ trackBpm }: { trackBpm: number | null }) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [bpm, setBpm] = useState("120");
  const [error, setError] = useState<string | null>(null);
  const [visualBeat, setVisualBeat] = useState<number | null>(null);
  const enabledRef = useRef(false);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => {
    const next = trackBpm !== null && Number.isFinite(trackBpm) && trackBpm >= 30 && trackBpm <= 300 ? Math.round(trackBpm) : 120;
    setBpm(String(next));
    if (enabledRef.current) playerSetMetronome(true, next).catch((cause) => setError(String(cause)));
  }, [trackBpm]);
  useEffect(() => {
    const value = Number(bpm);
    if (!enabled || !Number.isFinite(value) || value < 30 || value > 300) {
      setVisualBeat(null);
      return;
    }
    setVisualBeat(0);
    const timer = window.setInterval(() => setVisualBeat((beat) => beat === null ? 0 : (beat + 1) % 4), 60_000 / value);
    return () => window.clearInterval(timer);
  }, [enabled, bpm]);

  const applyBpm = (value: string) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 30 || next > 300) {
      setError("BPM must be between 30 and 300.");
      return;
    }
    const rounded = Math.round(next);
    setBpm(String(rounded));
    setError(null);
    if (enabled) playerSetMetronome(true, rounded).catch((cause) => setError(String(cause)));
  };
  const toggle = async () => {
    const next = !enabled;
    const value = Number(bpm);
    if (next && (!Number.isFinite(value) || value < 30 || value > 300)) {
      setError("BPM must be between 30 and 300.");
      return;
    }
    try {
      await playerSetMetronome(next, Number.isFinite(value) ? value : 120);
      setEnabled(next);
      enabledRef.current = next;
      setError(null);
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => {
    const handle = () => { void toggle(); };
    window.addEventListener("olooper:metronome-toggle", handle);
    return () => window.removeEventListener("olooper:metronome-toggle", handle);
  }, [enabled, bpm]);

  return <>
    <button onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Metronome settings"
      title={enabled ? `Metronome running at ${bpm} BPM` : "Metronome"} className={`toolbar-button ${enabled ? "text-accent" : ""}`}>
      ♩ {enabled ? bpm : "Metronome"}
    </button>
    {open && <section aria-label="Metronome controls" className="absolute right-3 top-full z-[100] w-64 rounded-lg border border-border bg-surface p-3 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-text">Metronome</h2>
        <button onClick={() => setOpen(false)} aria-label="Close metronome controls" className="dialog-close"><span aria-hidden="true">×</span> Close</button>
      </div>
      <label className="block text-[10px] text-text-secondary">Tempo (BPM)
        <div className="mt-1 flex items-center gap-1">
          <button onClick={() => applyBpm(String(Math.max(30, Number(bpm || 120) - 1)))} aria-label="Decrease metronome BPM" className="rounded bg-border px-2 py-1 text-text hover:bg-surface-hover">−</button>
          <input type="number" min={30} max={300} step={1} value={bpm} onChange={(event) => setBpm(event.target.value)} onBlur={() => applyBpm(bpm)} onKeyDown={(event) => { if (event.key === "Enter") applyBpm(bpm); }} className="min-w-0 flex-1 rounded border border-border bg-elevated px-2 py-1 text-center text-sm text-text" />
          <button onClick={() => applyBpm(String(Math.min(300, Number(bpm || 120) + 1)))} aria-label="Increase metronome BPM" className="rounded bg-border px-2 py-1 text-text hover:bg-surface-hover">+</button>
        </div>
      </label>
      <div className="mt-3 flex h-10 items-end justify-center gap-3" role="img" aria-label={visualBeat === null ? "Metronome beats inactive" : `Metronome beat ${visualBeat + 1} of 4`}>
        {Array.from({ length: 4 }, (_, beat) => <span key={beat} className={`w-2 rounded-full transition-all duration-75 ${visualBeat === beat ? beat === 0 ? "scale-125 bg-warning" : "scale-125 bg-accent" : beat === 0 ? "bg-warning/30" : "bg-border"}`} style={{ height: beat === 0 ? "2rem" : "1.4rem" }} />)}
      </div>
      <p className="mt-1 text-center text-[9px] text-text-secondary" aria-live="off">{visualBeat === null ? "Start to see the beat" : `Beat ${visualBeat + 1} / 4`}</p>
      <div className="mt-2 flex items-center justify-between">
        <button onClick={() => { if (trackBpm !== null) applyBpm(String(Math.round(trackBpm))); }} disabled={trackBpm === null} className="text-[10px] text-text-secondary hover:text-text disabled:opacity-40">Use track BPM{trackBpm !== null ? ` (${Math.round(trackBpm)})` : ""}</button>
        <button onClick={() => void toggle()} className={`rounded px-3 py-1.5 text-[10px] font-medium ${enabled ? "bg-danger/15 text-danger" : "bg-accent text-white"}`}>{enabled ? "Stop" : "Start"}</button>
      </div>
      {error && <p className="mt-2 text-[10px] text-danger" role="alert">{error}</p>}
    </section>}
  </>;
}
