import { useCallback, useEffect, useState } from "react";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import Player from "./components/Player";
import Waveform from "./components/Waveform";
import ImportBar from "./components/ImportBar";
import TablistCatalog from "./components/TablistCatalog";
import useKeyboardShortcuts from "./hooks/useKeyboardShortcuts";
import type { PlayerStatus, Track } from "./tauri";

export default function App() {
  useKeyboardShortcuts();
  const [libraryReady, setLibraryReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<number | null>(null);
  const [libraryView, setLibraryView] = useState<"local" | "tablist">("local");

  const onLibraryReady = useCallback(() => setLibraryReady(true), []);
  const onImported = useCallback(
    () => setRefreshKey((k) => k + 1),
    [],
  );
  const onTrackSelected = (track: Track, status: PlayerStatus) => {
    setActiveTrackId(track.id);
    setPlayerStatus(status);
  };

  // Listen for olooper:imported events from keyboard shortcut handler.
  useEffect(() => {
    const handler = () => onImported();
    window.addEventListener("olooper:imported", handler);
    return () => window.removeEventListener("olooper:imported", handler);
  }, [onImported]);

  return (
    <div className="h-screen flex flex-col bg-app text-text overflow-hidden">
      <TopBar onLibraryReady={onLibraryReady} />

      <main className="flex flex-1 min-h-0 flex-col">
        <div className="h-1/5 min-h-36 shrink-0 p-3">
          <Waveform refreshKey={refreshKey} status={playerStatus} onStatusChange={setPlayerStatus} />
        </div>
        <Player
          status={playerStatus}
          trackId={activeTrackId}
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
              Tablist Online
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {libraryView === "local" ? (
              <Sidebar
                libraryReady={libraryReady}
                refreshKey={refreshKey}
                onTrackSelected={onTrackSelected}
              />
            ) : (
              <TablistCatalog libraryReady={libraryReady} onImported={onImported} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
