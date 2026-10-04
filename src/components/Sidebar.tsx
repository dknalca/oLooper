import { useEffect, useRef, useState } from "react";
import {
  libraryList,
  libraryGroupCover,
  libraryMarkPlayed,
  libraryGroupDirectory,
  libraryExportTracks,
  libraryRemove,
  libraryRemoveLooper,
  libraryRenameLooper,
  librarySetFavorite,
  librarySyncSeratoMetadata,
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
  activeTrackId: number | null;
  onRegisterTrackNavigation: (navigate: ((direction: -1 | 1) => void) | null) => void;
  onTrackLoading: () => void;
  onTrackSelected: (track: Track, status: Awaited<ReturnType<typeof playerPlay>>) => void;
}

function groupName(track: Track): string {
  return track.looper_name;
}

const FAVORITES_GROUP = "__olooper_favorites__";
const DEFAULT_LOOPER_PANE_WIDTH = 224;
const MIN_LOOPER_PANE_WIDTH = 160;
const MAX_LOOPER_PANE_WIDTH = 420;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Sidebar({ libraryReady, refreshKey, activeTrackId, onRegisterTrackNavigation, onTrackLoading, onTrackSelected }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => localStorage.getItem("olooper.library.search") ?? "");
  const [sourceFilter, setSourceFilter] = useState(() => localStorage.getItem("olooper.library.source") ?? "all");
  const [bpmFilter, setBpmFilter] = useState(() => localStorage.getItem("olooper.library.bpm") ?? "all");
  const [durationFilter, setDurationFilter] = useState(() => localStorage.getItem("olooper.library.duration") ?? "all");
  const [sort, setSort] = useState<"alphabetical" | "bpm">(() => localStorage.getItem("olooper.library.sort")?.startsWith("bpm") ? "bpm" : "alphabetical");
  const [bpmDescending, setBpmDescending] = useState(() => localStorage.getItem("olooper.library.sort") === "bpm-desc");
  const [looperPaneWidth, setLooperPaneWidth] = useState(() => {
    const saved = Number(localStorage.getItem("olooper.library.looperPaneWidth"));
    return Number.isFinite(saved) && saved > 0
      ? Math.max(MIN_LOOPER_PANE_WIDTH, Math.min(MAX_LOOPER_PANE_WIDTH, saved))
      : DEFAULT_LOOPER_PANE_WIDTH;
  });
  const [selectedGroup, setSelectedGroup] = useState(() => localStorage.getItem("olooper.library.selectedGroup") ?? FAVORITES_GROUP);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<number | null>(null);
  const [groupMenu, setGroupMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 16, y: 16 });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const coverCache = useRef(new Map<string, string>());
  const trackNavigationRef = useRef<(direction: -1 | 1) => void>(() => {});
  const looperResizeStart = useRef<{ pointerX: number; width: number } | null>(null);
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
    const updateBpm = (event: Event) => {
      const { trackId, bpm } = (event as CustomEvent<{ trackId: number; bpm: number }>).detail;
      setTracks((current) => current.map((track) => track.id === trackId
        ? { ...track, bpm, bpm_source: "serato", bpm_confidence: null }
        : track));
    };
    window.addEventListener("olooper:track-bpm", updateBpm);
    return () => window.removeEventListener("olooper:track-bpm", updateBpm);
  }, []);

  useEffect(() => {
    if (activeTrackId === null) return;
    const activeTrack = tracks.find((track) => track.id === activeTrackId);
    if (activeTrack) {
      setActiveId(activeTrackId);
      setSelectedGroup(activeTrack.source_hash);
    }
  }, [activeTrackId, tracks]);

  useEffect(() => {
    if (!libraryReady) return;
    const sourceHashes = [...new Set(tracks
      .filter((track) => track.source_type !== "custom")
      .map((track) => track.source_hash))];
    const missing = sourceHashes.filter((sourceHash) => !coverCache.current.has(sourceHash));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(async (sourceHash) => {
      try {
        const cover = await libraryGroupCover(sourceHash);
        if (cover) coverCache.current.set(sourceHash, cover);
        return [sourceHash, cover] as const;
      } catch {
        return [sourceHash, null] as const;
      }
    })).then((loaded) => {
      if (cancelled) return;
      setCovers((current) => {
        const next = { ...current };
        for (const [sourceHash, cover] of loaded) {
          if (cover) next[sourceHash] = cover;
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [libraryReady, tracks]);

  useEffect(() => {
    if (contextMenu === null && groupMenu === null) return;
    const close = () => { setContextMenu(null); setGroupMenu(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu, groupMenu]);

  useEffect(() => { localStorage.setItem("olooper.library.search", search); }, [search]);
  useEffect(() => { localStorage.setItem("olooper.library.source", sourceFilter); }, [sourceFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.bpm", bpmFilter); }, [bpmFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.duration", durationFilter); }, [durationFilter]);
  useEffect(() => {
    localStorage.setItem("olooper.library.sort", sort === "bpm" ? (bpmDescending ? "bpm-desc" : "bpm") : "alphabetical");
  }, [sort, bpmDescending]);
  useEffect(() => {
    localStorage.setItem("olooper.library.looperPaneWidth", String(looperPaneWidth));
  }, [looperPaneWidth]);
  useEffect(() => { localStorage.setItem("olooper.library.selectedGroup", selectedGroup); }, [selectedGroup]);

  const looperGroups = Object.values(tracks.reduce<Record<string, Track[]>>((result, track) => {
    (result[track.source_hash] ??= []).push(track);
    return result;
  }, {}));
  const filtered = tracks.filter((track) => {
    const needle = search.toLowerCase();
    const matchesSearch = !search || track.title.toLowerCase().includes(needle) || groupName(track).toLowerCase().includes(needle) || track.tags.toLowerCase().includes(needle);
    const matchesSource = sourceFilter === "all" || track.source_type === sourceFilter;
    const matchesBpm = bpmFilter === "all" || (track.bpm !== null && (bpmFilter === "low" ? track.bpm < 100 : bpmFilter === "mid" ? track.bpm <= 130 : track.bpm > 130));
    const matchesDuration = durationFilter === "all" || (durationFilter === "short" ? track.duration_ms < 10_000 : durationFilter === "mid" ? track.duration_ms <= 30_000 : track.duration_ms > 30_000);
    return matchesSearch && matchesSource && matchesBpm && matchesDuration;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "bpm" && a.bpm !== b.bpm) {
      if (a.bpm === null) return 1;
      if (b.bpm === null) return -1;
      return (a.bpm - b.bpm) * (bpmDescending ? -1 : 1);
    }
    return a.title.localeCompare(b.title);
  });
  const selectedTracks = sorted.filter((track) => selectedGroup === FAVORITES_GROUP
    ? track.favorite
    : track.source_hash === selectedGroup);
  const hasPlayableTracks = selectedTracks.some((track) => track.exists);
  const favoritesCount = tracks.filter((track) => track.favorite).length;
  const selectedLooper = looperGroups.find((group) => group[0].source_hash === selectedGroup)?.[0];

  useEffect(() => {
    if (selectedGroup !== FAVORITES_GROUP && tracks.length > 0 && !selectedLooper) {
      setSelectedGroup(FAVORITES_GROUP);
    }
  }, [selectedGroup, selectedLooper, tracks.length]);

  const playTrack = async (track: Track) => {
    onTrackLoading();
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

  trackNavigationRef.current = (direction) => {
    const playable = selectedTracks.filter((track) => track.exists);
    if (playable.length === 0) return;
    const index = playable.findIndex((track) => track.id === activeId);
    const nextIndex = index < 0
      ? (direction > 0 ? 0 : playable.length - 1)
      : (index + direction + playable.length) % playable.length;
    void playTrack(playable[nextIndex]);
  };

  useEffect(() => {
    const navigate = (direction: -1 | 1) => trackNavigationRef.current(direction);
    onRegisterTrackNavigation(libraryReady && hasPlayableTracks ? navigate : null);
    return () => onRegisterTrackNavigation(null);
  }, [hasPlayableTracks, libraryReady, onRegisterTrackNavigation]);

  const deleteTrack = (id: number) => {
    libraryRemove(id).then(refresh).catch((e) => { refresh(); setError(String(e)); });
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
    libraryUpdateMetadata(track.id, title, bpm, tags).then(async (updated) => {
      if (updated.bpm !== null && updated.bpm !== track.bpm) {
        try {
          await librarySyncSeratoMetadata(track.id);
        } catch (cause) {
          refresh();
          setError(`BPM saved in oLooper, but Serato sync failed: ${String(cause)}`);
          return;
        }
      }
      refresh();
    }).catch((cause) => setError(String(cause)));
    setContextMenu(null);
  };

  const removeGroup = (sourceHash: string, name: string) => {
    if (!window.confirm(`Remove “${name}” and delete its library audio copies and cover? Original SWF/EXE/source files will be kept.`)) return;
    libraryRemoveLooper(sourceHash).then(refresh).catch((e) => { refresh(); setError(String(e)); });
    setGroupMenu(null);
  };

  const openTrackMenu = (event: React.MouseEvent, trackId: number) => {
    event.preventDefault();
    setGroupMenu(null);
    setContextMenu(trackId);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const openGroupMenu = (event: React.MouseEvent, sourceHash: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setGroupMenu(sourceHash);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const totalDuration = selectedTracks.reduce((sum, track) => sum + track.duration_ms, 0);

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
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Looper library" style={{ width: looperPaneWidth }} className="flex shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Loopers</span>
            <span className="text-[10px] tabular-nums text-text-secondary">{looperGroups.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <button
              onClick={() => setSelectedGroup(FAVORITES_GROUP)}
              aria-current={selectedGroup === FAVORITES_GROUP ? "page" : undefined}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${selectedGroup === FAVORITES_GROUP ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-danger/10 text-sm text-danger">♥</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">Favoritos</span>
              <span className="text-[10px] tabular-nums">{favoritesCount}</span>
            </button>
            {looperGroups.map((entries) => {
              const sourceHash = entries[0].source_hash;
              const isSelected = selectedGroup === sourceHash;
              return (
                <div
                  key={sourceHash}
                  onContextMenu={entries[0].source_type === "custom" ? undefined : (event) => openGroupMenu(event, sourceHash)}
                  className={`group flex items-center rounded transition-colors ${isSelected ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
                >
                  <button
                    onClick={() => setSelectedGroup(sourceHash)}
                    aria-current={isSelected ? "page" : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                  >
                    {covers[sourceHash]
                      ? <img src={covers[sourceHash]} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                      : <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-border text-sm text-text-secondary">♫</span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{groupName(entries[0])}</span>
                      <span className="block truncate text-[9px] uppercase opacity-70">{entries[0].source_type}</span>
                    </span>
                    <span className="text-[10px] tabular-nums">{entries.length}</span>
                  </button>
                  {entries[0].source_type !== "custom" && (
                    <button
                      onClick={(event) => openGroupMenu(event, sourceHash)}
                      title={`${groupName(entries[0])} actions`}
                      aria-label={`${groupName(entries[0])} actions`}
                      className="mr-1 rounded px-1.5 py-1 text-xs text-text-secondary opacity-0 hover:bg-border hover:text-text group-hover:opacity-100 focus:opacity-100"
                    >•••</button>
                  )}
                </div>
              );
            })}
          </div>
        </nav>
        <div
          role="separator"
          aria-label="Resize looper column"
          aria-orientation="vertical"
          aria-valuemin={MIN_LOOPER_PANE_WIDTH}
          aria-valuemax={MAX_LOOPER_PANE_WIDTH}
          aria-valuenow={looperPaneWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            looperResizeStart.current = { pointerX: event.clientX, width: looperPaneWidth };
          }}
          onPointerMove={(event) => {
            const start = looperResizeStart.current;
            if (!start) return;
            setLooperPaneWidth(Math.max(
              MIN_LOOPER_PANE_WIDTH,
              Math.min(MAX_LOOPER_PANE_WIDTH, start.width + event.clientX - start.pointerX),
            ));
          }}
          onPointerUp={(event) => {
            looperResizeStart.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => { looperResizeStart.current = null; }}
          onDoubleClick={() => setLooperPaneWidth(DEFAULT_LOOPER_PANE_WIDTH)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const amount = event.key === "ArrowLeft" ? -16 : 16;
              setLooperPaneWidth((width) => Math.max(MIN_LOOPER_PANE_WIDTH, Math.min(MAX_LOOPER_PANE_WIDTH, width + amount)));
            }
          }}
          className="group relative z-10 -ml-[3px] w-[6px] shrink-0 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-0 after:left-[2px] after:w-px after:bg-border hover:after:bg-accent focus-visible:after:bg-accent"
        />

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <h2 className="mr-auto min-w-0 truncate text-xs font-semibold text-text">
              {selectedGroup === FAVORITES_GROUP ? "Favoritos" : selectedLooper ? groupName(selectedLooper) : "Library"}
            </h2>
            <input aria-label="Search tracks" placeholder="Search loops…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-24 flex-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent" />
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter source" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Source</option><option value="swf">SWF</option><option value="exe">EXE</option><option value="custom">Audio</option></select>
            <select value={bpmFilter} onChange={(e) => setBpmFilter(e.target.value)} aria-label="Filter BPM" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">BPM</option><option value="low">&lt;100</option><option value="mid">100–130</option><option value="high">&gt;130</option></select>
            <select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value)} aria-label="Filter duration" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Length</option><option value="short">&lt;10s</option><option value="mid">10–30s</option><option value="long">&gt;30s</option></select>
            <button disabled={selectedIds.length === 0} onClick={exportSelected} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40">Export {selectedIds.length || ""}</button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem] gap-2 border-b border-border bg-elevated/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem]">
            <button
              onClick={() => { setSort("alphabetical"); setBpmDescending(false); }}
              aria-sort={sort === "alphabetical" ? "ascending" : "none"}
              className="truncate text-left hover:text-text"
              title="Sort loops alphabetically"
            >Loop{sort === "alphabetical" ? " ↑" : ""}</button>
            <button
              onClick={() => {
                if (sort === "bpm") setBpmDescending((descending) => !descending);
                else { setSort("bpm"); setBpmDescending(false); }
              }}
              aria-sort={sort === "bpm" ? (bpmDescending ? "descending" : "ascending") : "none"}
              className="text-right hover:text-text"
              title="Sort loops by BPM"
            >BPM{sort === "bpm" ? (bpmDescending ? " ↓" : " ↑") : ""}</button>
            <span className="text-right">Length</span>
            <span className="text-right">Actions</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!libraryReady && <p className="px-3 py-4 text-center text-xs text-text-secondary">Choose a library folder to begin</p>}
            {libraryReady && selectedTracks.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-text-secondary">
                {tracks.length === 0
                  ? "No tracks imported"
                  : selectedGroup === FAVORITES_GROUP && favoritesCount === 0
                    ? "No favorite loops yet"
                    : "No matches"}
              </p>
            )}
            {selectedTracks.map((track) => (
              <div
                key={track.id}
                onClick={() => setActiveId(track.id)}
                onDoubleClick={() => void playTrack(track)}
                onContextMenu={(event) => openTrackMenu(event, track.id)}
                role="button"
                tabIndex={track.exists ? 0 : -1}
                onKeyDown={(event) => {
                  // The row is keyboard-activatable, but its child buttons and
                  // checkbox must keep their own Enter/Space behavior.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter") void playTrack(track);
                  if (event.key === " ") setActiveId(track.id);
                }}
                className={`grid w-full grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem] items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs transition-colors sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem] ${activeId === track.id ? "bg-accent/10 text-accent" : "text-text hover:bg-surface-hover"} ${!track.exists ? "pointer-events-none opacity-40" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <input type="checkbox" checked={selectedIds.includes(track.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedIds((ids) => ids.includes(track.id) ? ids.filter((id) => id !== track.id) : [...ids, track.id])} aria-label={`Select ${track.title}`} />
                  <button
                    onClick={(event) => { event.stopPropagation(); void playTrack(track); }}
                    title={`Play ${track.title}`}
                    aria-label={`Play ${track.title}`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/10 text-[10px] text-accent hover:bg-accent/20"
                  >{loadingId === track.id ? "…" : "▶"}</button>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{track.title}</span>
                    {track.tags && <span className="block truncate text-[10px] text-text-secondary">{track.tags}</span>}
                  </span>
                </span>
                <span className={`text-right text-[11px] tabular-nums ${track.bpm ? "text-success" : "text-text-secondary"}`}>{track.bpm ? `${Math.round(track.bpm)} bpm` : "--"}</span>
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
                      if (window.confirm(`Remove “${track.title}” and delete its audio copy from the library? The original source file will be kept.`)) deleteTrack(track.id);
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
          </div>
          <div className="flex justify-between border-t border-border px-3 py-1.5 text-[10px] text-text-secondary">
            <span>{selectedTracks.length} loop{selectedTracks.length === 1 ? "" : "s"}</span>
            <span>{Math.floor(totalDuration / 60000)}m {Math.floor((totalDuration % 60000) / 1000)}s</span>
          </div>
        </section>
      </div>
      {contextMenu !== null && (
        <div
          className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl"
          style={{ left: Math.min(menuPosition.x, window.innerWidth - 200), top: Math.min(menuPosition.y, window.innerHeight - 150) }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) void playTrack(track); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Play now</button>
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) revealInFileManager(track.file_path).catch((e: unknown) => setError(String(e))); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Reveal audio file</button>
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) toggleFavorite(track); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">{tracks.find((item) => item.id === contextMenu)?.favorite ? "Remove favorite" : "Add favorite"}</button>
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) editTrack(track); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Edit metadata</button>
          <button
            onClick={() => {
              const track = tracks.find((item) => item.id === contextMenu);
              if (track && window.confirm(`Remove “${track.title}” and delete its audio copy from the library? The original source file will be kept.`)) {
                deleteTrack(track.id);
              }
            }}
            className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
          >Remove from library</button>
        </div>
      )}
      {groupMenu !== null && (() => {
        const track = tracks.find((item) => item.source_hash === groupMenu);
        if (!track) return null;
        return (
          <div
            className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl"
            style={{ left: Math.min(menuPosition.x, window.innerWidth - 200), top: Math.min(menuPosition.y, window.innerHeight - 120) }}
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => { libraryGroupDirectory(groupMenu).then(revealInFileManager).catch((e: unknown) => setError(String(e))); setGroupMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Open looper folder</button>
            <button onClick={() => renameGroup(groupMenu, groupName(track))} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Rename looper</button>
            <button onClick={() => removeGroup(groupMenu, groupName(track))} className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10">Remove group from library</button>
          </div>
        );
      })()}
      {error && <div className="border-t border-danger/30 px-3 py-1.5 text-[10px] text-danger" role="alert">{error}</div>}
    </aside>
  );
}
