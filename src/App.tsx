import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import Player from "./components/Player";
import Waveform from "./components/Waveform";
import ImportBar from "./components/ImportBar";
import TablistCatalog from "./components/TablistCatalog";
import useKeyboardShortcuts from "./hooks/useKeyboardShortcuts";
import { libraryRandomTrack, listenAppMenuCommand, playerLoad, playerPlay, playerStatus as getPlayerStatus, type PlayerStatus, type Track } from "./tauri";

type TrackNavigator = (direction: -1 | 1) => void;

export default function App() {
  useKeyboardShortcuts();
  const [libraryReady, setLibraryReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<number | null>(null);
  const [activeTrack, setActiveTrack] = useState<Track | null>(null);
  const [trackNavigator, setTrackNavigator] = useState<TrackNavigator | null>(null);
  const [libraryView, setLibraryView] = useState<"local" | "tablist">("local");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const randomLoadGeneration = useRef(0);

  const onLibraryReady = useCallback(() => setLibraryReady(true), []);
  const onImported = useCallback(
    () => setRefreshKey((k) => k + 1),
    [],
  );
  const onTrackSelected = useCallback((track: Track, status: PlayerStatus) => {
    randomLoadGeneration.current += 1;
    setActiveTrackId(track.id);
    setActiveTrack(track);
    setPlayerStatus(status);
  }, []);

  const registerTrackNavigator = useCallback((navigate: TrackNavigator | null) => {
    setTrackNavigator(() => navigate);
  }, []);

  const onTrackLoading = useCallback(() => {
    randomLoadGeneration.current += 1;
  }, []);

  const playRandomTrack = useCallback(async () => {
    const generation = ++randomLoadGeneration.current;
    const track = await libraryRandomTrack(activeTrackId);
    if (!track) throw new Error("No playable tracks in the library");
    if (generation !== randomLoadGeneration.current) return;

    let status = await playerLoad(track.file_path);
    setPlayerStatus(status);
    const deadline = Date.now() + 120_000;
    while (status.loading && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (generation !== randomLoadGeneration.current) return;
      status = await getPlayerStatus();
      setPlayerStatus(status);
    }
    if (generation !== randomLoadGeneration.current) return;
    if (status.loading) throw new Error("Random track load timed out");
    if (status.load_error) throw new Error(status.load_error);
    if (status.path !== track.file_path) return;
    const playing = await playerPlay();
    if (generation !== randomLoadGeneration.current) return;
    setActiveTrackId(track.id);
    setActiveTrack(track);
    setPlayerStatus(playing);
  }, [activeTrackId]);

  // Listen for olooper:imported events from keyboard shortcut handler.
  useEffect(() => {
    const handler = () => onImported();
    window.addEventListener("olooper:imported", handler);
    return () => window.removeEventListener("olooper:imported", handler);
  }, [onImported]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenAppMenuCommand((command) => {
      if (command === "show-shortcuts") {
        setShortcutsOpen(true);
      } else if (command === "choose-library") {
        window.dispatchEvent(new Event("olooper:choose-library"));
      } else {
        window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: command }));
      }
    }).then((dispose) => { unlisten = dispose; }).catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShortcutsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [shortcutsOpen]);

  return (
    <div className="h-screen flex flex-col bg-app text-text overflow-hidden">
      <TopBar onLibraryReady={onLibraryReady} playing={playerStatus?.playing ?? false} />

      <main className="flex flex-1 min-h-0 flex-col">
        <div className="h-1/5 min-h-36 shrink-0 p-3">
          <Waveform refreshKey={refreshKey} status={playerStatus} trackTitle={activeTrack?.title ?? null} onStatusChange={setPlayerStatus} />
        </div>
        <Player
          status={playerStatus}
          trackId={activeTrackId}
          canRandom={libraryReady && activeTrackId !== null}
          onRandomTrack={playRandomTrack}
          canNavigateTracks={trackNavigator !== null}
          onPreviousTrack={() => trackNavigator?.(-1)}
          onNextTrack={() => trackNavigator?.(1)}
          onStatusChange={setPlayerStatus}
        />
        <section className="flex min-h-0 flex-1 flex-col border-t border-border">
          <ImportBar onImported={onImported} />
          <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-3 pt-1.5" role="tablist" aria-label="Library views">
            <button
              role="tab"
              aria-selected={libraryView === "local"}
              onClick={() => setLibraryView("local")}
              className={`rounded-t px-3 py-1.5 text-[11px] ${libraryView === "local" ? "border border-border border-b-surface bg-surface text-text" : "text-text-secondary hover:text-text"}`}
            >
              My Library
            </button>
            <button
              role="tab"
              aria-selected={libraryView === "tablist"}
              onClick={() => setLibraryView("tablist")}
              className={`rounded-t px-3 py-1.5 text-[11px] ${libraryView === "tablist" ? "border border-border border-b-surface bg-surface text-text" : "text-text-secondary hover:text-text"}`}
            >
              Download new Loopers
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {libraryView === "local" ? (
              <Sidebar
                libraryReady={libraryReady}
                refreshKey={refreshKey}
                activeTrackId={activeTrackId}
                onRegisterTrackNavigation={registerTrackNavigator}
                onTrackLoading={onTrackLoading}
                onTrackSelected={onTrackSelected}
              />
            ) : (
              <TablistCatalog libraryReady={libraryReady} refreshKey={refreshKey} onImported={onImported} />
            )}
          </div>
        </section>
      </main>
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
          onClick={() => setShortcutsOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            className="w-full max-w-lg rounded-lg border border-border bg-surface p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 id="shortcuts-title" className="text-base font-semibold text-text">Keyboard Shortcuts</h2>
              <button
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close keyboard shortcuts"
                className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-border hover:text-text"
              >Close</button>
            </header>
            <div className="space-y-4 text-xs">
              <section aria-label="Playback shortcuts">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Playback</h3>
                <ShortcutRow keys="Space" action="Play / pause" />
                <ShortcutRow keys="S" action="Stop at loop start" />
                <ShortcutRow keys="← / →" action="Seek 5 seconds" />
                <ShortcutRow keys="L" action="Toggle looping" />
                <ShortcutRow keys="1–4" action="Recall a cue; save an empty cue at the current position" />
                <ShortcutRow keys="Shift + 2–4" action="Clear a saved cue" />
                <ShortcutRow keys="Shift + 1" action="Return to the fixed start cue" />
                <ShortcutRow keys="+ / −" action="Adjust playback speed by 5%" />
              </section>
              <section aria-label="Application shortcuts">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Application</h3>
                <ShortcutRow keys="⌘ / Ctrl + O" action="Open File → Import Files…" />
                <ShortcutRow keys="⌘ + W" action="Close window" />
                <ShortcutRow keys="⌘ + Q" action="Quit oLooper" />
                <ShortcutRow keys="⌘ + Z / ⇧⌘ + Z" action="Undo / redo text edits" />
                <ShortcutRow keys="⌘ + X / C / V / A" action="Cut / copy / paste / select all" />
              </section>
            </div>
            <p className="mt-4 text-[10px] text-text-secondary">Transport shortcuts are disabled while typing in text fields.</p>
          </section>
        </div>
      )}
    </div>
  );
}

function ShortcutRow({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <kbd className="shrink-0 rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text">{keys}</kbd>
      <span className="text-right text-text-secondary">{action}</span>
    </div>
  );
}
