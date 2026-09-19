import { useCallback, useEffect, useState } from "react";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import Player from "./components/Player";
import Waveform from "./components/Waveform";
import ImportBar from "./components/ImportBar";
import useKeyboardShortcuts from "./hooks/useKeyboardShortcuts";
import type { PlayerStatus, Track } from "./tauri";

export default function App() {
  useKeyboardShortcuts();
  const [libraryReady, setLibraryReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [activeTrackId, setActiveTrackId] = useState<number | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);

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

      <div className="flex flex-1 min-h-0">
        {/* Sidebar: library track list */}
        <div className={`${sidebarExpanded ? "w-96" : "w-64"} shrink-0 transition-[width] duration-200`}>
          <Sidebar
            libraryReady={libraryReady}
            refreshKey={refreshKey}
            onTrackSelected={onTrackSelected}
            expanded={sidebarExpanded}
            onToggleExpanded={() => setSidebarExpanded((expanded) => !expanded)}
          />
        </div>

        {/* Main area: waveform + player + import */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex-1 p-3 min-h-0">
            <Waveform refreshKey={refreshKey} status={playerStatus} />
          </div>
          <Player
            status={playerStatus}
            trackId={activeTrackId}
            onStatusChange={setPlayerStatus}
          />
          <ImportBar onImported={onImported} />
        </div>
      </div>
    </div>
  );
}
