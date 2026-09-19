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
}

function groupName(track: Track): string {
  if (track.source_type === "custom") return "Custom Loops";
  const file = track.source_path.split(/[\\/]/).pop() ?? "Looper";
  return file.replace(/\.[^.]+$/, "") || "Looper";
}

export default function Sidebar({ libraryReady, refreshKey, onTrackSelected }: Props) {
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
    <aside className="relative flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-text-secondary">Library</div>
        <input aria-label="Search tracks" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded bg-elevated border border-border px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent" />
      </div>
      <div className="grid grid-cols-[minmax(11rem,1.2fr)_minmax(12rem,2fr)_5.5rem_5rem] gap-3 border-b border-border bg-elevated/50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        <span>Source looper</span>
        <span>Loop</span>
        <span className="text-right">BPM</span>
        <span className="text-right">Length</span>
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
                className="flex w-full items-center gap-2 border-y border-border/50 bg-elevated/30 px-4 py-2 text-left text-[11px] font-medium text-text-secondary hover:bg-surface-hover"
              >
                <span className="w-3 text-center">{isCollapsed ? "›" : "⌄"}</span>
                <span className="truncate">{name}</span>
                <span className="rounded bg-border px-1.5 py-0.5 text-[9px] uppercase">{entries[0].source_type}</span>
                <span className="ml-auto text-[10px]">{entries.length}</span>
              </button>
              {!isCollapsed && entries.map((track) => (
                <button
                  key={track.id}
                  onClick={() => setActiveId(track.id)}
                  onDoubleClick={() => playTrack(track)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu(track.id); }}
                  disabled={!track.exists}
                  className={`grid w-full grid-cols-[minmax(11rem,1.2fr)_minmax(12rem,2fr)_5.5rem_5rem] items-center gap-3 px-4 py-2 text-left text-xs transition-colors ${activeId === track.id ? "bg-accent/10 text-accent" : "text-text hover:bg-surface-hover"} ${!track.exists ? "opacity-40" : ""}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-text-secondary">
                    <span className="w-3 shrink-0 text-center">{activeId === track.id ? "▸" : "♪"}</span>
                    <span className="truncate">{name}</span>
                  </span>
                  <span className="truncate font-medium">{track.title}</span>
                  <span className={`text-right text-[11px] tabular-nums ${track.bpm ? "text-success" : "text-text-secondary"}`}>
                    {track.bpm ? `${Math.round(track.bpm)} ${track.bpm_source === "analyzed" ? "calc" : ""}` : "--"}
                  </span>
                  <span className="text-right text-[11px] tabular-nums text-text-secondary">{(track.duration_ms / 1000).toFixed(1)}s</span>
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
