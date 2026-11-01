import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  getAppStatus,
  libraryDefaultRoot,
  libraryInit,
  libraryRestore,
  pickDirectory,
  type AppStatus,
} from "../tauri";
import Logo from "./Logo";
import MetronomeControls from "./MetronomeControls";
import { displayLibraryPath } from "../displayLibraryPath";

interface Props {
  onLibraryReady: (root: string) => void;
  playing: boolean;
  onAudioOptions: () => void;
  onMidiOptions: () => void;
  onShortcuts: () => void;
  onPreferences: () => void;
  trackBpm: number | null;
  children?: ReactNode;
}

export default function TopBar({ onLibraryReady, playing, onAudioOptions, onMidiOptions, onShortcuts, onPreferences, trackBpm, children }: Props) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [root, setRoot] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [practiceSeconds, setPracticeSeconds] = useState(0);
  const accumulatedMs = useRef(0);
  const segmentStartedAt = useRef<number | null>(null);
  const libraryRequest = useRef(0);
  const librarySelected = useRef(false);

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

  useEffect(() => {
    let cancelled = false;
    const request = ++libraryRequest.current;
    const current = () => !cancelled && request === libraryRequest.current;
    let restoreFailed = false;
    const rememberedRoot = localStorage.getItem("olooper.library.root");
    Promise.all([getAppStatus(), libraryDefaultRoot(), libraryRestore(rememberedRoot).catch((cause) => {
      restoreFailed = true;
      if (current()) setError(`Could not open the saved library: ${String(cause)}`);
      return null;
    })])
      .then(([appStatus, defaultRoot, savedRoot]) => {
        if (cancelled) return;
        // Status is independent of the chosen library; a delayed startup may
        // still provide it after a newer manual selection has started.
        setStatus((previous) => previous ?? { ...appStatus, library_set: librarySelected.current });
        if (!current()) return;
        try {
          if (savedRoot) localStorage.setItem("olooper.library.root", savedRoot);
          else if (rememberedRoot && !restoreFailed) localStorage.removeItem("olooper.library.root");
        } catch (cause) { setError(`Library opened, but its preference could not be saved: ${String(cause)}`); }
        setRoot(savedRoot ?? (restoreFailed ? rememberedRoot ?? defaultRoot : defaultRoot));
        librarySelected.current = savedRoot !== null;
        setStatus({ ...appStatus, library_set: savedRoot !== null });
        if (savedRoot) onLibraryReady(savedRoot);
        else setSetupOpen(true);
      })
      .catch((e) => current() && setError(`Could not prepare library: ${String(e)}`));
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
    const request = ++libraryRequest.current;
    const current = () => request === libraryRequest.current;
    setInitializing(true);
    setError(null);
    libraryInit(root)
      .then((libraryRoot) => {
        if (!current()) return;
        librarySelected.current = true;
        setStatus((current) => current ? { ...current, library_set: true } : current);
        try { localStorage.setItem("olooper.library.root", libraryRoot); }
        catch (cause) { setError(`Library opened, but its preference could not be saved: ${String(cause)}`); }
        setRoot(libraryRoot);
        setSetupOpen(false);
        onLibraryReady(libraryRoot);
      })
      .catch((e) => { if (current()) setError(String(e)); })
      .finally(() => { if (current()) setInitializing(false); });
  };

  return (
    <>
      <header className="workspace-header">
        <div className="flex items-center gap-2">
          <div data-app-logo className="h-6 w-6 shrink-0">
            <Logo className="h-6 w-6" />
          </div>
          <span className="font-semibold text-sm tracking-wide text-text">oLooper</span>
        </div>
        {status && (
          <>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary">v{status.version}</span>
            <button
              onClick={() => setSetupOpen(true)}
              className="toolbar-button"
            >
              {status.library_set ? "Library folder" : "Set up library"}
            </button>
          </>
        )}
        {children}
        <MetronomeControls trackBpm={trackBpm} />
        <button
          onClick={onAudioOptions}
          aria-label="Audio output settings"
          title="Choose audio output device and stereo pair"
          className="toolbar-button"
        >
          ♫ Audio
        </button>
        <button onClick={onMidiOptions} className="toolbar-button" title="Connect and map a MIDI controller">MIDI</button>
        <button onClick={onShortcuts} className="toolbar-button" title="Keyboard shortcuts">Shortcuts</button>
        <button onClick={onPreferences} className="toolbar-button" title="Application appearance preferences">Preferences</button>
        {root && <span className="hidden min-w-0 flex-1 truncate text-[10px] text-text-secondary xl:block" title={displayLibraryPath(root)}>{displayLibraryPath(root)}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2 rounded-lg border border-border/60 bg-app px-3 py-2" title="Practice time while audio is playing">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${playing ? "bg-success" : "bg-text-secondary/40"}`} />
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
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-text">Choose your library folder</h2>
              <button onClick={() => setSetupOpen(false)} disabled={initializing} className="dialog-close"><span aria-hidden="true">×</span> Close</button>
            </div>
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
