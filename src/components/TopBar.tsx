import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getAppStatus,
  libraryDefaultRoot,
  libraryInit,
  libraryRestore,
  playerSetMetronome,
  pickDirectory,
  type AppStatus,
} from "../tauri";
import Logo from "./Logo";
import { displayLibraryPath } from "../displayLibraryPath";

interface Props {
  onLibraryReady: (root: string) => void;
  playing: boolean;
  onAudioOptions: () => void;
  trackBpm: number | null;
  children?: ReactNode;
}

export default function TopBar({ onLibraryReady, playing, onAudioOptions, trackBpm, children }: Props) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [root, setRoot] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practiceSeconds, setPracticeSeconds] = useState(0);
  const [metronomeOpen, setMetronomeOpen] = useState(false);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [metronomeBpm, setMetronomeBpm] = useState("120");
  const [metronomeError, setMetronomeError] = useState<string | null>(null);
  const [visualBeat, setVisualBeat] = useState<number | null>(null);
  const accumulatedMs = useRef(0);
  const segmentStartedAt = useRef<number | null>(null);
  const metronomeEnabledRef = useRef(false);

  useEffect(() => { metronomeEnabledRef.current = metronomeEnabled; }, [metronomeEnabled]);

  useEffect(() => {
    const bpm = trackBpm !== null && Number.isFinite(trackBpm) && trackBpm >= 30 && trackBpm <= 300
      ? Math.round(trackBpm)
      : 120;
    setMetronomeBpm(String(bpm));
    if (metronomeEnabledRef.current) {
      playerSetMetronome(true, bpm).catch((cause) => setMetronomeError(String(cause)));
    }
  }, [trackBpm]);

  useEffect(() => {
    const bpm = Number(metronomeBpm);
    if (!metronomeEnabled || !Number.isFinite(bpm) || bpm < 30 || bpm > 300) {
      setVisualBeat(null);
      return;
    }
    setVisualBeat(0);
    const timer = window.setInterval(() => {
      setVisualBeat((beat) => beat === null ? 0 : (beat + 1) % 4);
    }, 60_000 / bpm);
    return () => window.clearInterval(timer);
  }, [metronomeEnabled, metronomeBpm]);

  useEffect(() => {
    if (!playing) {
      if (segmentStartedAt.current !== null) {
        accumulatedMs.current += Date.now() - segmentStartedAt.current;
        segmentStartedAt.current = null;
        setPracticeSeconds(Math.floor(accumulatedMs.current / 1000));
      }
      return;
    }
    segmentStartedAt.current = Date.now();
    const timer = window.setInterval(() => {
      const currentSegment = segmentStartedAt.current === null
        ? 0
        : Date.now() - segmentStartedAt.current;
      setPracticeSeconds(Math.floor((accumulatedMs.current + currentSegment) / 1000));
    }, 250);
    return () => {
      window.clearInterval(timer);
      if (segmentStartedAt.current !== null) {
        accumulatedMs.current += Date.now() - segmentStartedAt.current;
        segmentStartedAt.current = null;
        setPracticeSeconds(Math.floor(accumulatedMs.current / 1000));
      }
    };
  }, [playing]);

  const resetPracticeTimer = () => {
    accumulatedMs.current = 0;
    segmentStartedAt.current = playing ? Date.now() : null;
    setPracticeSeconds(0);
  };

  const applyMetronomeBpm = (value: string) => {
    const bpm = Number(value);
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) {
      setMetronomeError("BPM must be between 30 and 300.");
      return;
    }
    const rounded = Math.round(bpm);
    setMetronomeBpm(String(rounded));
    setMetronomeError(null);
    if (metronomeEnabled) {
      playerSetMetronome(true, rounded).catch((cause) => setMetronomeError(String(cause)));
    }
  };

  const toggleMetronome = async () => {
    const enabled = !metronomeEnabled;
    const bpm = Number(metronomeBpm);
    if (enabled && (!Number.isFinite(bpm) || bpm < 30 || bpm > 300)) {
      setMetronomeError("BPM must be between 30 and 300.");
      return;
    }
    try {
      await playerSetMetronome(enabled, Number.isFinite(bpm) ? bpm : 120);
      setMetronomeEnabled(enabled);
      metronomeEnabledRef.current = enabled;
      setMetronomeError(null);
    } catch (cause) {
      setMetronomeError(String(cause));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const rememberedRoot = localStorage.getItem("olooper.library.root");
    Promise.all([getAppStatus(), libraryDefaultRoot(), libraryRestore(rememberedRoot)])
      .then(([appStatus, defaultRoot, savedRoot]) => {
        if (cancelled) return;
        if (savedRoot) localStorage.setItem("olooper.library.root", savedRoot);
        else if (rememberedRoot) localStorage.removeItem("olooper.library.root");
        setRoot(savedRoot ?? defaultRoot);
        setStatus({ ...appStatus, library_set: savedRoot !== null });
        if (savedRoot) onLibraryReady(savedRoot);
        else setSetupOpen(true);
      })
      .catch((e) => !cancelled && setError(`Could not prepare library: ${String(e)}`));
    return () => { cancelled = true; };
  }, [onLibraryReady]);

  useEffect(() => {
    const openSetup = () => setSetupOpen(true);
    window.addEventListener("olooper:choose-library", openSetup);
    return () => window.removeEventListener("olooper:choose-library", openSetup);
  }, []);

  const browseRoot = async () => {
    const selected = await pickDirectory();
    if (selected) setRoot(selected);
  };

  const init = () => {
    setInitializing(true);
    setError(null);
    libraryInit(root)
      .then((libraryRoot) => {
        setStatus((current) => current ? { ...current, library_set: true } : current);
        localStorage.setItem("olooper.library.root", libraryRoot);
        setRoot(libraryRoot);
        setSetupOpen(false);
        onLibraryReady(libraryRoot);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setInitializing(false));
  };

  return (
    <>
      <header className="relative flex items-center gap-3 px-4 h-10 border-b border-border bg-surface shrink-0 select-none">
        <div className="flex items-center gap-2">
          <div data-app-logo className="h-6 w-6 shrink-0">
            <Logo className="h-6 w-6" />
          </div>
          <span className="font-semibold text-sm tracking-wide text-text">oLooper</span>
        </div>
        {status && (
          <>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary">v{status.version}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary">{status.platform}</span>
            <button
              onClick={() => setSetupOpen(true)}
              className={`text-[10px] px-1.5 py-0.5 rounded ${status.library_set ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}
            >
              {status.library_set ? "change library" : "set library"}
            </button>
          </>
        )}
        {children}
        <button
          onClick={() => setMetronomeOpen((open) => !open)}
          aria-expanded={metronomeOpen}
          aria-label="Metronome settings"
          title={metronomeEnabled ? `Metronome running at ${metronomeBpm} BPM` : "Metronome"}
          className={`rounded px-2 py-1 text-[10px] ${metronomeEnabled ? "bg-accent/20 text-accent" : "text-text-secondary hover:bg-border hover:text-text"}`}
        >♩ {metronomeEnabled ? metronomeBpm : "Metronome"}</button>
        {metronomeOpen && (
          <section aria-label="Metronome controls" className="absolute right-3 top-10 z-[100] w-64 rounded-lg border border-border bg-surface p-3 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-text">Metronome</h2>
              <button onClick={() => setMetronomeOpen(false)} aria-label="Close metronome controls" className="rounded px-1.5 text-text-secondary hover:bg-border">×</button>
            </div>
            <label className="block text-[10px] text-text-secondary">
              Tempo (BPM)
              <div className="mt-1 flex items-center gap-1">
                <button onClick={() => applyMetronomeBpm(String(Math.max(30, Number(metronomeBpm || 120) - 1)))} aria-label="Decrease metronome BPM" className="rounded bg-border px-2 py-1 text-text hover:bg-surface-hover">−</button>
                <input type="number" min={30} max={300} step={1} value={metronomeBpm} onChange={(event) => setMetronomeBpm(event.target.value)} onBlur={() => applyMetronomeBpm(metronomeBpm)} onKeyDown={(event) => { if (event.key === "Enter") applyMetronomeBpm(metronomeBpm); }} className="min-w-0 flex-1 rounded border border-border bg-elevated px-2 py-1 text-center text-sm text-text" />
                <button onClick={() => applyMetronomeBpm(String(Math.min(300, Number(metronomeBpm || 120) + 1)))} aria-label="Increase metronome BPM" className="rounded bg-border px-2 py-1 text-text hover:bg-surface-hover">+</button>
              </div>
            </label>
            <div className="mt-3 flex h-10 items-end justify-center gap-3" role="img" aria-label={visualBeat === null ? "Metronome beats inactive" : `Metronome beat ${visualBeat + 1} of 4`}>
              {Array.from({ length: 4 }, (_, beat) => (
                <span
                  key={beat}
                  className={`w-2 rounded-full transition-all duration-75 ${visualBeat === beat ? beat === 0 ? "scale-125 bg-warning" : "scale-125 bg-accent" : beat === 0 ? "bg-warning/30" : "bg-border"}`}
                  style={{ height: beat === 0 ? "2rem" : "1.4rem" }}
                />
              ))}
            </div>
            <p className="mt-1 text-center text-[9px] text-text-secondary" aria-live="off">{visualBeat === null ? "Start to see the beat" : `Beat ${visualBeat + 1} / 4`}</p>
            <div className="mt-2 flex items-center justify-between">
              <button onClick={() => { if (trackBpm !== null) applyMetronomeBpm(String(Math.round(trackBpm))); }} disabled={trackBpm === null} className="text-[10px] text-text-secondary hover:text-text disabled:opacity-40">Use track BPM{trackBpm !== null ? ` (${Math.round(trackBpm)})` : ""}</button>
              <button onClick={() => void toggleMetronome()} className={`rounded px-3 py-1.5 text-[10px] font-medium ${metronomeEnabled ? "bg-danger/15 text-danger" : "bg-accent text-white"}`}>{metronomeEnabled ? "Stop" : "Start"}</button>
            </div>
            {metronomeError && <p className="mt-2 text-[10px] text-danger" role="alert">{metronomeError}</p>}
          </section>
        )}
        <button
          onClick={onAudioOptions}
          aria-label="Audio output settings"
          title="Choose audio output device and stereo pair"
          className="rounded px-2 py-1 text-[10px] text-text-secondary hover:bg-border hover:text-text"
        >
          ♫ Audio
        </button>
        {root && <span className="ml-auto truncate max-w-64 text-[10px] text-text-secondary" title={displayLibraryPath(root)}>{displayLibraryPath(root)}</span>}
        <div className="flex shrink-0 items-center gap-1.5 rounded bg-elevated px-2 py-1" title="Practice time while audio is playing">
          <span className="text-[9px] uppercase tracking-wide text-text-secondary">Practice</span>
          <span className="font-mono text-[11px] tabular-nums text-text" aria-live="off">
            {String(Math.floor(practiceSeconds / 3600)).padStart(2, "0")}:
            {String(Math.floor((practiceSeconds % 3600) / 60)).padStart(2, "0")}:
            {String(practiceSeconds % 60).padStart(2, "0")}
          </span>
          <button
            onClick={resetPracticeTimer}
            title="Reset practice timer"
            aria-label="Reset practice timer"
            className="rounded px-1 text-xs text-text-secondary hover:bg-border hover:text-text"
          >
            ↺
          </button>
        </div>
        {error && <span className="text-xs text-danger" role="alert">{error}</span>}
      </header>

      {setupOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-app/80 backdrop-blur-sm">
          <div className="w-[28rem] rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-text">Choose your library folder</h2>
            <p className="mt-1 text-xs text-text-secondary">Audio will be stored here. The suggested location is the Documents folder inside `oLooper_data`; you can choose another folder.</p>
            <div className="mt-4 flex gap-2">
              <input
                aria-label="Library root path"
                value={displayLibraryPath(root)}
                onChange={(event) => setRoot(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-elevated px-2 py-1.5 text-xs text-text focus:border-accent"
              />
              <button onClick={browseRoot} className="rounded bg-border px-3 text-xs text-text-secondary hover:text-text">Browse</button>
            </div>
            {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end">
              <button
                onClick={init}
                disabled={initializing || !root}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-app disabled:opacity-40"
              >
                {initializing ? "Preparing…" : "Use this folder"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
