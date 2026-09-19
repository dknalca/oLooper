import { useEffect, useState } from "react";
import {
  libraryList,
  libraryRemove,
  playerLoad,
  playerPlay,
  revealInFileManager,
  type Track,
} from "../tauri";

interface Props {
  libraryReady: boolean;
  refreshKey: number;
  onTrackSelected: (track: Track, status: Awaited<ReturnType<typeof playerPlay>>) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}

function groupName(track: Track): string {
  if (track.source_type === "custom") return "Custom Loops";
  const file = track.source_path.split(/[\\/]/).pop() ?? "Looper";
  return file.replace(/\.[^.]+$/, "") || "Looper";
}

export default function Sidebar({ libraryReady, refreshKey, onTrackSelected, expanded, onToggleExpanded }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<number | null>(null);

  const refresh = () => libraryList()
    .then((next) => { setError(null); setTracks(next); })
    .catch((e) => setError(String(e)));

  useEffect(() => {
    if (libraryReady) refresh();
  }, [libraryReady, refreshKey]);

  useEffect(() => {
    if (contextMenu === null) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  const filtered = search
    ? tracks.filter((track) => track.title.toLowerCase().includes(search.toLowerCase()) || groupName(track).toLowerCase().includes(search.toLowerCase()))
    : tracks;
  const groups = filtered.reduce<Record<string, Track[]>>((result, track) => {
    const name = groupName(track);
    (result[name] ??= []).push(track);
    return result;
  }, {});

  const playTrack = async (track: Track) => {
    setError(null);
    setActiveId(track.id);
    try {
      await playerLoad(track.file_path);
      onTrackSelected(track, await playerPlay());
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteTrack = (id: number) => {
    libraryRemove(id).then(refresh).catch((e) => setError(String(e)));
    setContextMenu(null);
  };

  const totalDuration = tracks.reduce((sum, track) => sum + track.duration_ms, 0);

  return (
    <aside className="flex h-full flex-col bg-surface border-r border-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <input aria-label="Search tracks" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded bg-elevated border border-border px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent" />
        <button onClick={onToggleExpanded} title={expanded ? "Collapse library" : "Expand library"} className="rounded p-1 text-text-secondary hover:bg-surface-hover hover:text-text">
          {expanded ? "‹" : "›"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!libraryReady && <p className="px-3 py-4 text-center text-xs text-text-secondary">Choose a library folder to begin</p>}
        {libraryReady && filtered.length === 0 && <p className="px-3 py-4 text-center text-xs text-text-secondary">{tracks.length === 0 ? "No tracks imported" : "No matches"}</p>}
        {Object.entries(groups).map(([name, entries]) => {
          const isCollapsed = collapsed[name] ?? false;
          return (
            <section key={name} className="border-b border-border/60">
              <button
                onClick={() => setCollapsed((current) => ({ ...current, [name]: !isCollapsed }))}
                className="flex w-full items-center gap-1 px-3 py-2 text-left text-[11px] font-medium text-text-secondary hover:bg-surface-hover"
              >
                <span className="w-3 text-center">{isCollapsed ? "›" : "⌄"}</span>
                <span className="truncate">{name}</span>
                <span className="ml-auto text-[10px]">{entries.length}</span>
              </button>
              {!isCollapsed && entries.map((track) => (
                <button
                  key={track.id}
                  onClick={() => setActiveId(track.id)}
                  onDoubleClick={() => playTrack(track)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu(track.id); }}
                  disabled={!track.exists}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-xs transition-colors ${activeId === track.id ? "bg-accent/10 text-accent" : "text-text hover:bg-surface-hover"} ${!track.exists ? "opacity-40" : ""}`}
                >
                  <span className="w-3 shrink-0 text-center text-text-secondary">{activeId === track.id ? "▸" : "♪"}</span>
                  <span className="min-w-0 flex-1 truncate">{track.title}</span>
                  <span className="shrink-0 text-[10px] text-text-secondary">{(track.duration_ms / 1000).toFixed(1)}s</span>
                  {track.bpm && <span className="shrink-0 text-[10px] text-success">{Math.round(track.bpm)}</span>}
                </button>
              ))}
            </section>
          );
        })}
      </div>
      {contextMenu !== null && (
        <div className="absolute bottom-8 right-2 z-50 min-w-[160px] rounded border border-border bg-elevated py-1 shadow-lg">
          <button onClick={() => {
            const track = tracks.find((item) => item.id === contextMenu);
            if (track) revealInFileManager(track.file_path).catch((e: unknown) => setError(String(e)));
            setContextMenu(null);
          }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Reveal in file manager</button>
          <button onClick={() => deleteTrack(contextMenu)} className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10">Remove from library</button>
        </div>
      )}
      <div className="flex justify-between border-t border-border px-3 py-1.5 text-[10px] text-text-secondary">
        <span>{tracks.length} track{tracks.length === 1 ? "" : "s"}</span>
        <span>{Math.floor(totalDuration / 60000)}m {Math.floor((totalDuration % 60000) / 1000)}s</span>
      </div>
      {error && <div className="border-t border-danger/30 px-3 py-1.5 text-[10px] text-danger" role="alert">{error}</div>}
    </aside>
  );
}
