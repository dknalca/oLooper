import { useEffect, useRef, useState } from "react";
import {
  libraryList,
  libraryMarkPlayed,
  libraryGroupDirectory,
  libraryExportTracks,
  libraryRemove,
  libraryRemoveLooper,
  libraryRenameLooper,
  librarySetFavorite,
  libraryUpdateMetadata,
  playerLoad,
  playerSetDiagnostics,
  playerStatus,
  pickDirectory,
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
  return track.looper_name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Sidebar({ libraryReady, refreshKey, onTrackSelected }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => localStorage.getItem("olooper.library.search") ?? "");
  const [favoritesOnly, setFavoritesOnly] = useState(() => localStorage.getItem("olooper.library.favorites") === "true");
  const [sourceFilter, setSourceFilter] = useState(() => localStorage.getItem("olooper.library.source") ?? "all");
  const [bpmFilter, setBpmFilter] = useState(() => localStorage.getItem("olooper.library.bpm") ?? "all");
  const [durationFilter, setDurationFilter] = useState(() => localStorage.getItem("olooper.library.duration") ?? "all");
  const [sort, setSort] = useState(() => localStorage.getItem("olooper.library.sort") ?? "imported");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<number | null>(null);
  const [groupMenu, setGroupMenu] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  // Newest selection wins: older in-flight loads are abandoned (the backend
  // discards superseded decodes by load generation).
  const loadSeq = useRef(0);

  const refresh = () => libraryList()
    .then((next) => { setError(null); setTracks(next); setSelectedIds((ids) => ids.filter((id) => next.some((track) => track.id === id))); })
    .catch((e) => setError(String(e)));

  useEffect(() => {
    if (libraryReady) refresh();
  }, [libraryReady, refreshKey]);

  useEffect(() => {
    if (contextMenu === null && groupMenu === null) return;
    const close = () => { setContextMenu(null); setGroupMenu(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu, groupMenu]);

  useEffect(() => { localStorage.setItem("olooper.library.search", search); }, [search]);
  useEffect(() => { localStorage.setItem("olooper.library.favorites", String(favoritesOnly)); }, [favoritesOnly]);
  useEffect(() => { localStorage.setItem("olooper.library.source", sourceFilter); }, [sourceFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.bpm", bpmFilter); }, [bpmFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.duration", durationFilter); }, [durationFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.sort", sort); }, [sort]);

  const filtered = tracks.filter((track) => {
    const needle = search.toLowerCase();
    const matchesSearch = !search || track.title.toLowerCase().includes(needle) || groupName(track).toLowerCase().includes(needle) || track.tags.toLowerCase().includes(needle);
    const matchesSource = sourceFilter === "all" || track.source_type === sourceFilter;
    const matchesFavorite = !favoritesOnly || track.favorite;
    const matchesBpm = bpmFilter === "all" || (track.bpm !== null && (bpmFilter === "low" ? track.bpm < 100 : bpmFilter === "mid" ? track.bpm <= 130 : track.bpm > 130));
    const matchesDuration = durationFilter === "all" || (durationFilter === "short" ? track.duration_ms < 10_000 : durationFilter === "mid" ? track.duration_ms <= 30_000 : track.duration_ms > 30_000);
    return matchesSearch && matchesSource && matchesFavorite && matchesBpm && matchesDuration;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "bpm") return (a.bpm ?? Number.POSITIVE_INFINITY) - (b.bpm ?? Number.POSITIVE_INFINITY);
    if (sort === "duration") return a.duration_ms - b.duration_ms;
    if (sort === "recent") return (b.last_played_at ?? 0) - (a.last_played_at ?? 0);
    return b.imported_at - a.imported_at;
  });
  const groups = sorted.reduce<Record<string, Track[]>>((result, track) => {
    (result[track.source_hash] ??= []).push(track);
    return result;
  }, {});

  const playTrack = async (track: Track) => {
    const my = loadSeq.current + 1;
    loadSeq.current = my;
    const previousId = activeId;
    setError(null);
    // Immediate visual selection; decode happens in the background and the
    // previous audio keeps playing until the new buffer proves valid.
    setActiveId(track.id);
    setLoadingId(track.id);
    try {
      let st = await playerLoad(track.file_path);
      const deadline = Date.now() + 120_000;
      while (st.loading && Date.now() < deadline) {
        if (loadSeq.current !== my) return; // superseded by newer selection
        await sleep(150);
        st = await playerStatus();
      }
      if (loadSeq.current !== my) return;
      if (st.loading) throw new Error("load timed out");
      if (st.load_error) throw new Error(st.load_error);
      if (st.path !== track.file_path) return; // another track won meanwhile
      setLoadingId(null);
      playerSetDiagnostics(track.loop_origin, track.loop_quality).catch(() => {});
      onTrackSelected(track, await playerPlay());
      libraryMarkPlayed(track.id).then(refresh).catch(() => {});
    } catch (e) {
      if (loadSeq.current !== my) return;
      setLoadingId(null);
      setActiveId(previousId); // keep the previous (still sounding) track
      setError(String(e));
    }
  };

  const deleteTrack = (id: number) => {
    libraryRemove(id).then(refresh).catch((e) => setError(String(e)));
    setContextMenu(null);
  };

  const toggleFavorite = (track: Track) => {
    librarySetFavorite(track.id, !track.favorite)
      .then((updated) => setTracks((current) => current.map((item) => item.id === updated.id ? updated : item)))
      .catch((e) => setError(String(e)));
  };

  const renameGroup = (sourceHash: string, currentName: string) => {
    const name = window.prompt("New looper name", currentName)?.trim();
    if (!name || name === currentName) return;
    libraryRenameLooper(sourceHash, name).then(refresh).catch((e) => setError(String(e)));
    setGroupMenu(null);
  };

  const editTrack = (track: Track) => {
    const title = window.prompt("Loop title", track.title)?.trim();
    if (!title) return;
    const bpmInput = window.prompt("BPM (leave empty to keep current)", track.bpm?.toString() ?? "");
    if (bpmInput === null) return;
    const bpm = bpmInput.trim() ? Number(bpmInput) : track.bpm;
    if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) { setError("BPM must be between 20 and 300"); return; }
    const tags = window.prompt("Tags (comma separated)", track.tags)?.trim();
    if (tags === undefined) return;
    libraryUpdateMetadata(track.id, title, bpm, tags).then(refresh).catch((e) => setError(String(e)));
    setContextMenu(null);
  };

  const removeGroup = (sourceHash: string, name: string) => {
    if (!window.confirm(`Remove all loops from “${name}” from the library? Audio and source files will be kept.`)) return;
    libraryRemoveLooper(sourceHash).then(refresh).catch((e) => setError(String(e)));
    setGroupMenu(null);
  };

  const totalDuration = tracks.reduce((sum, track) => sum + track.duration_ms, 0);

  const exportSelected = async () => {
    const destination = await pickDirectory();
    if (!destination) return;
    try {
      const count = await libraryExportTracks(selectedIds, destination);
      setError(null);
      window.alert(`Exported ${count} loop${count === 1 ? "" : "s"}.`);
    } catch (e) { setError(String(e)); }
  };

  return (
    <aside className="relative flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-text-secondary">Library</div>
        <input aria-label="Search tracks" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded bg-elevated border border-border px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent" />
        <button onClick={() => setFavoritesOnly((value) => !value)} title="Favorites only" className={`rounded px-2 py-1 text-xs ${favoritesOnly ? "bg-danger/15 text-danger" : "bg-elevated text-text-secondary"}`}>♥</button>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter source" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Source</option><option value="swf">SWF</option><option value="exe">EXE</option><option value="custom">Audio</option></select>
        <select value={bpmFilter} onChange={(e) => setBpmFilter(e.target.value)} aria-label="Filter BPM" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">BPM</option><option value="low">&lt;100</option><option value="mid">100–130</option><option value="high">&gt;130</option></select>
        <select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value)} aria-label="Filter duration" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Length</option><option value="short">&lt;10s</option><option value="mid">10–30s</option><option value="long">&gt;30s</option></select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort tracks" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="imported">Imported</option><option value="recent">Recent</option><option value="title">Title</option><option value="bpm">BPM</option><option value="duration">Length</option></select>
        <button disabled={selectedIds.length === 0} onClick={exportSelected} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40">Export {selectedIds.length || ""}</button>
      </div>
      <div className="grid grid-cols-[minmax(11rem,1.2fr)_minmax(12rem,2fr)_5.5rem_5rem_4rem] gap-3 border-b border-border bg-elevated/50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        <span>Source looper</span>
        <span>Loop</span>
        <span className="text-right">BPM</span>
        <span className="text-right">Length</span>
        <span className="text-right">Keep</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!libraryReady && <p className="px-3 py-4 text-center text-xs text-text-secondary">Choose a library folder to begin</p>}
        {libraryReady && filtered.length === 0 && <p className="px-3 py-4 text-center text-xs text-text-secondary">{tracks.length === 0 ? "No tracks imported" : "No matches"}</p>}
        {Object.entries(groups).map(([sourceHash, entries]) => {
          const name = groupName(entries[0]);
          const isCollapsed = collapsed[sourceHash] ?? false;
          return (
            <section key={sourceHash} className="border-b border-border/60">
              <div className="flex items-center gap-2 border-y border-border/50 bg-elevated/30 px-4 py-2 text-[11px] font-medium text-text-secondary">
                <button onClick={() => setCollapsed((current) => ({ ...current, [sourceHash]: !isCollapsed }))} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-text">
                <span className="w-3 text-center">{isCollapsed ? "›" : "⌄"}</span>
                <span className="truncate">{name}</span>
                <span className="rounded bg-border px-1.5 py-0.5 text-[9px] uppercase">{entries[0].source_type}</span>
                </button>
                <span className="text-[10px]">{entries.length}</span>
                {entries[0].source_type !== "custom" && <button onClick={(event) => { event.stopPropagation(); setGroupMenu(sourceHash); }} title="Manage looper" className="rounded px-1.5 py-0.5 text-text-secondary hover:bg-border hover:text-text">•••</button>}
              </div>
              {!isCollapsed && entries.map((track) => (
                <div
                  key={track.id}
                  onClick={() => setActiveId(track.id)}
                  onDoubleClick={() => playTrack(track)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu(track.id); }}
                  role="button"
                  tabIndex={track.exists ? 0 : -1}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") playTrack(track);
                    if (event.key === " ") setActiveId(track.id);
                  }}
                  className={`grid w-full grid-cols-[minmax(11rem,1.2fr)_minmax(12rem,2fr)_5.5rem_5rem_4rem] items-center gap-3 px-4 py-2 text-left text-xs transition-colors ${activeId === track.id ? "bg-accent/10 text-accent" : "text-text hover:bg-surface-hover"} ${!track.exists ? "opacity-40 pointer-events-none" : ""}`}
                >
                   <span className="flex min-w-0 items-center gap-2 text-text-secondary">
                     <input type="checkbox" checked={selectedIds.includes(track.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedIds((ids) => ids.includes(track.id) ? ids.filter((id) => id !== track.id) : [...ids, track.id])} aria-label={`Select ${track.title}`} />
                    <span className="w-3 shrink-0 text-center" title={loadingId === track.id ? "Loading audio…" : undefined}>{loadingId === track.id ? "…" : activeId === track.id ? "▸" : "♪"}</span>
                    <span className="truncate">{name}</span>
                  </span>
                   <span className="min-w-0"><span className="block truncate font-medium">{track.title}</span>{track.tags && <span className="block truncate text-[10px] text-text-secondary">{track.tags}</span>}</span>
                  <span className={`text-right text-[11px] tabular-nums ${track.bpm ? "text-success" : "text-text-secondary"}`}>
                    {track.bpm ? `${Math.round(track.bpm)} bpm` : "--"}
                  </span>
                  <span className="text-right text-[11px] tabular-nums text-text-secondary">{(track.duration_ms / 1000).toFixed(1)}s</span>
                  <span className="flex justify-end gap-1">
                    <button
                      onClick={(event) => { event.stopPropagation(); toggleFavorite(track); }}
                      title={track.favorite ? "Remove favorite" : "Add favorite"}
                      aria-label={track.favorite ? "Remove favorite" : "Add favorite"}
                      className={`rounded px-1.5 py-1 text-sm leading-none hover:bg-border ${track.favorite ? "text-danger" : "text-text-secondary hover:text-danger"}`}
                    >{track.favorite ? "♥" : "♡"}</button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        if (window.confirm(`Remove “${track.title}” from the library? Audio will be kept.`)) deleteTrack(track.id);
                      }}
                      title="Remove from library"
                      aria-label="Remove from library"
                      className="rounded px-1.5 py-1 text-text-secondary hover:bg-danger/10 hover:text-danger"
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current" aria-hidden="true"><path d="M5.5 1h5l.8 2H14v1.5H2V3h2.7l.8-2zM4.2 5.5h7.6l-.6 8.5H4.8l-.6-8.5zM6 7v5h1V7H6zm3 0v5h1V7H9z" /></svg>
                    </button>
                  </span>
                </div>
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
           <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) editTrack(track); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Edit metadata</button>
          <button onClick={() => deleteTrack(contextMenu)} className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10">Remove from library</button>
        </div>
      )}
      {groupMenu !== null && (() => {
        const track = tracks.find((item) => item.source_hash === groupMenu);
        if (!track) return null;
        return (
          <div className="absolute right-2 top-24 z-50 min-w-[190px] rounded border border-border bg-elevated py-1 shadow-lg">
            <button onClick={() => libraryGroupDirectory(groupMenu).then(revealInFileManager).catch((e: unknown) => setError(String(e)))} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Open looper folder</button>
            <button onClick={() => renameGroup(groupMenu, groupName(track))} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Rename looper</button>
            <button onClick={() => removeGroup(groupMenu, groupName(track))} className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10">Remove group from library</button>
          </div>
        );
      })()}
      <div className="flex justify-between border-t border-border px-3 py-1.5 text-[10px] text-text-secondary">
        <span>{tracks.length} track{tracks.length === 1 ? "" : "s"}</span>
        <span>{Math.floor(totalDuration / 60000)}m {Math.floor((totalDuration % 60000) / 1000)}s</span>
      </div>
      {error && <div className="border-t border-danger/30 px-3 py-1.5 text-[10px] text-danger" role="alert">{error}</div>}
    </aside>
  );
}
