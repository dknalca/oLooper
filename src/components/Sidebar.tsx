import { useEffect, useRef, useState } from "react";
import {
  libraryList,
  libraryGroupCover,
  libraryMarkPlayed,
  libraryGroupDirectory,
  libraryExportTracks,
  libraryPlaylists,
  libraryLooperOrder,
  libraryReorderLoopers,
  libraryCreatePlaylist,
  libraryRenamePlaylist,
  libraryRemovePlaylist,
  libraryAddTrackToPlaylist,
  libraryRemoveTrackFromPlaylist,
  libraryReorderPlaylist,
  libraryDragTrackOut,
  libraryConvertWavToMp3_320,
  libraryRemove,
  libraryRemoveLooper,
  libraryRenameLooper,
  librarySetFavorite,
  librarySyncSeratoMetadata,
  libraryUpdateMetadata,
  playerLoadTrack,
  playerPause,
  playerSetDiagnostics,
  playerStatus,
  pickDirectory,
  playerPlay,
  revealInFileManager,
  type Playlist,
  type Track,
} from "../tauri";
import { recordTempoTap } from "../tapTempo";

interface Props {
  libraryReady: boolean;
  libraryGeneration: number;
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
const ALL_GROUP = "__olooper_all__";
const PLAYLIST_PREFIX = "__olooper_playlist__:";
const BPM_REVIEW_THRESHOLD = 0.5;
const DEFAULT_LOOPER_PANE_WIDTH = 224;
const MIN_LOOPER_PANE_WIDTH = 160;
const MAX_LOOPER_PANE_WIDTH = 420;

type LibraryPointerDrag =
  | { kind: "track"; pointerId: number; startX: number; startY: number; sourceTrackId: number; trackIds: number[]; canDesktopDrag: boolean; active: boolean }
  | { kind: "looper"; pointerId: number; startX: number; startY: number; sourceHash: string; active: boolean };

type LibraryDropTarget =
  | { kind: "playlist"; playlistId: number; element: HTMLElement }
  | { kind: "favorites"; element: HTMLElement }
  | { kind: "waveform"; element: HTMLElement }
  | { kind: "looper"; sourceHash: string; element: HTMLElement }
  | null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Sidebar({ libraryReady, libraryGeneration, refreshKey, activeTrackId, onRegisterTrackNavigation, onTrackLoading, onTrackSelected }: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [looperOrder, setLooperOrder] = useState<string[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
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
  const [playlistMenu, setPlaylistMenu] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<LibraryDropTarget>(null);
  const [draggingTrackIds, setDraggingTrackIds] = useState<number[]>([]);
  const [playlistTrackId, setPlaylistTrackId] = useState<number | null>(null);
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);
  const [playlistFormMode, setPlaylistFormMode] = useState<"create" | "rename">("create");
  const [editingPlaylistId, setEditingPlaylistId] = useState<number | null>(null);
  const [createPlaylistName, setCreatePlaylistName] = useState("");
  const [createPlaylistError, setCreatePlaylistError] = useState<string | null>(null);
  const [createPlaylistBusy, setCreatePlaylistBusy] = useState(false);
  const [createPlaylistTrackId, setCreatePlaylistTrackId] = useState<number | null>(null);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [metadataDraft, setMetadataDraft] = useState({ title: "", bpm: "", tags: "" });
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [bpmConfirmed, setBpmConfirmed] = useState(false);
  const [tapTempoCount, setTapTempoCount] = useState(0);
  const [tapTempoEstimate, setTapTempoEstimate] = useState<number | null>(null);
  const tapTempoTimes = useRef<number[]>([]);
  const [menuPosition, setMenuPosition] = useState({ x: 16, y: 16 });
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [libraryRevealGeneration, setLibraryRevealGeneration] = useState(0);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const coverCache = useRef(new Map<string, string>());
  const trackNavigationRef = useRef<(direction: -1 | 1) => void>(() => {});
  const looperResizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const internalLibraryDrag = useRef(false);
  const pointerDrag = useRef<LibraryPointerDrag | null>(null);
  const suppressRowClick = useRef(false);
  const desktopDragTimer = useRef<number | null>(null);
  const selectedGroupRef = useRef(selectedGroup);
  selectedGroupRef.current = selectedGroup;
  const activeTrackIdRef = useRef(activeTrackId);
  activeTrackIdRef.current = activeTrackId;
  const previousLibraryGeneration = useRef(libraryGeneration);
  // Newest selection wins: older in-flight loads are abandoned (the backend
  // discards superseded decodes by load generation).
  const loadSeq = useRef(0);
  const supportsDesktopDrag = /Macintosh|Mac OS X/i.test(navigator.userAgent)
    || navigator.platform.toLowerCase().startsWith("mac");

  useEffect(() => () => {
    document.documentElement.classList.remove("olooper-library-pointer-drag");
  }, []);

  const refresh = () => Promise.all([libraryList(), libraryPlaylists(), libraryLooperOrder()])
    .then(([next, nextPlaylists, nextLooperOrder]) => {
      setError(null);
      setTracks(next);
      setPlaylists(nextPlaylists);
      setLooperOrder(nextLooperOrder);
      setCatalogLoaded(true);
      setSelectedIds((ids) => ids.filter((id) => next.some((track) => track.id === id)));
    })
    .catch((e) => setError(String(e)));

  useEffect(() => {
    if (previousLibraryGeneration.current === libraryGeneration) return;
    previousLibraryGeneration.current = libraryGeneration;
    loadSeq.current += 1;
    onTrackLoading();
    setTracks([]);
    setPlaylists([]);
    setLooperOrder([]);
    setSelectedGroup(FAVORITES_GROUP);
    setActiveId(null);
    setSelectedIds([]);
    setContextMenu(null);
    setGroupMenu(null);
    setPlaylistMenu(null);
    setPlaylistTrackId(null);
    setCreatePlaylistOpen(false);
    setEditingTrack(null);
    setMetadataError(null);
    setBpmConfirmed(false);
    tapTempoTimes.current = [];
    setTapTempoCount(0);
    setTapTempoEstimate(null);
    setCovers({});
    coverCache.current.clear();
    setError(null);
  }, [libraryGeneration, onTrackLoading]);

  useEffect(() => {
    if (libraryReady) refresh();
  }, [libraryReady, refreshKey]);

  useEffect(() => {
    const updateBpm = (event: Event) => {
      const { trackId, bpm, source = "serato" } = (event as CustomEvent<{ trackId: number; bpm: number; source?: string }>).detail;
      setTracks((current) => current.map((track) => track.id === trackId
        ? { ...track, bpm, bpm_source: source, bpm_confidence: null }
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
      const currentCollection = selectedGroupRef.current;
      if (currentCollection !== ALL_GROUP && currentCollection !== FAVORITES_GROUP && !currentCollection.startsWith(PLAYLIST_PREFIX)) {
        setSelectedGroup(activeTrack.source_hash);
      }
    }
  }, [activeTrackId, tracks]);

  useEffect(() => {
    const revealTrack = (event: Event) => {
      const { trackId, sourceHash } = (event as CustomEvent<{ trackId: number; sourceHash: string }>).detail;
      if (!Number.isSafeInteger(trackId) || typeof sourceHash !== "string") return;
      const reveal = () => {
        setActiveId(trackId);
        setSelectedGroup(sourceHash);
        setLibraryRevealGeneration((generation) => generation + 1);
      };
      if (tracks.some((track) => track.id === trackId)) reveal();
      else void refresh().then(reveal);
    };
    window.addEventListener("olooper:reveal-library-track", revealTrack);
    return () => window.removeEventListener("olooper:reveal-library-track", revealTrack);
  }, [tracks]);

  useEffect(() => {
    if (activeId === null) return;
    document.querySelector<HTMLElement>(`[data-library-track-id="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, libraryRevealGeneration, selectedGroup]);

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
    if (contextMenu === null && groupMenu === null && playlistMenu === null) return;
    const close = () => { setContextMenu(null); setGroupMenu(null); setPlaylistMenu(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu, groupMenu, playlistMenu]);

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
  }, {})).sort((left, right) => {
    const leftHash = left[0].source_hash;
    const rightHash = right[0].source_hash;
    const leftPosition = looperOrder.indexOf(leftHash);
    const rightPosition = looperOrder.indexOf(rightHash);
    if (leftPosition < 0 && rightPosition < 0) return left[0].id - right[0].id;
    if (leftPosition < 0) return 1;
    if (rightPosition < 0) return -1;
    return leftPosition - rightPosition;
  });
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
  const selectedPlaylistId = selectedGroup.startsWith(PLAYLIST_PREFIX)
    ? Number(selectedGroup.slice(PLAYLIST_PREFIX.length))
    : null;
  const selectedPlaylist = selectedPlaylistId === null
    ? undefined
    : playlists.find((playlist) => playlist.id === selectedPlaylistId);
  const filteredById = new Map(filtered.map((track) => [track.id, track]));
  const selectedTracks = selectedPlaylist
    ? selectedPlaylist.track_ids.flatMap((id) => {
      const track = filteredById.get(id);
      return track ? [track] : [];
    })
    : sorted.filter((track) => selectedGroup === ALL_GROUP
      || (selectedGroup === FAVORITES_GROUP ? track.favorite : track.source_hash === selectedGroup));
  const hasPlayableTracks = selectedTracks.some((track) => track.exists);
  const favoritesCount = tracks.filter((track) => track.favorite).length;
  const selectedLooper = looperGroups.find((group) => group[0].source_hash === selectedGroup)?.[0];

  useEffect(() => {
    if (
      selectedGroup !== FAVORITES_GROUP
      && selectedGroup !== ALL_GROUP
      && !selectedGroup.startsWith(PLAYLIST_PREFIX)
      && tracks.length > 0
      && !selectedLooper
    ) {
      setSelectedGroup(FAVORITES_GROUP);
    }
    if (catalogLoaded && selectedGroup.startsWith(PLAYLIST_PREFIX) && !selectedPlaylist) {
      setSelectedGroup(FAVORITES_GROUP);
    }
  }, [catalogLoaded, selectedGroup, selectedLooper, selectedPlaylist, tracks.length]);

  const playTrack = async (track: Track, resumeAfterLoad = true) => {
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
      let st = await playerLoadTrack(track.id);
      const deadline = Date.now() + 120_000;
      while (st.loading && Date.now() < deadline) {
        if (loadSeq.current !== my) return; // superseded by newer selection
        await sleep(150);
        st = await playerStatus();
      }
      if (loadSeq.current !== my) return;
      if (st.loading) throw new Error("load timed out");
      if (st.load_error) throw new Error(st.load_error);
      if (st.path !== track.playback_path) return; // another track won meanwhile
      setLoadingId(null);
      playerSetDiagnostics(track.loop_origin, track.loop_quality).catch(() => {});
      const finalStatus = resumeAfterLoad ? await playerPlay() : await playerStatus();
      onTrackSelected(track, finalStatus);
      if (resumeAfterLoad) libraryMarkPlayed(track.id).then(refresh).catch(() => {});
    } catch (e) {
      if (loadSeq.current !== my) return;
      setLoadingId(null);
      setActiveId(previousId); // keep the previous (still sounding) track
      setError(String(e));
    }
  };

  useEffect(() => {
    const playDroppedTrack = (event: Event) => {
      const trackId = (event as CustomEvent<number>).detail;
      const track = tracks.find((item) => item.id === trackId);
      if (track?.exists) void playTrack(track);
    };
    window.addEventListener("olooper:play-library-track", playDroppedTrack);
    return () => window.removeEventListener("olooper:play-library-track", playDroppedTrack);
  }, [playTrack, tracks]);

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

  const convertWavToMp3 = async (track: Track) => {
    if (!window.confirm(`Convert “${track.title}” to MP3 at 320 kbps and delete its managed WAV copy after verification? The original source will be kept.`)) return;
    setConvertingId(track.id);
    setContextMenu(null);
    const isActive = activeTrackId === track.id;
    let wasPlaying = false;
    try {
      if (isActive) {
        const status = await playerStatus();
        wasPlaying = status.playing;
        if (wasPlaying) onTrackSelected(track, await playerPause());
      }
      const converted = await libraryConvertWavToMp3_320(track.id);
      await refresh();
      if (isActive && activeTrackIdRef.current === track.id) await playTrack(converted, wasPlaying);
    } catch (cause) {
      if (isActive && wasPlaying && activeTrackIdRef.current === track.id) {
        try { onTrackSelected(track, await playerPlay()); } catch { /* Keep the conversion error visible. */ }
      }
      setError(String(cause));
    } finally {
      setConvertingId(null);
    }
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

  const createPlaylist = (addTrackId?: number) => {
    setPlaylistFormMode("create");
    setEditingPlaylistId(null);
    setCreatePlaylistName("");
    setCreatePlaylistError(null);
    setCreatePlaylistTrackId(addTrackId ?? null);
    setPlaylistTrackId(null);
    setCreatePlaylistOpen(true);
  };

  const submitPlaylistCreation = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = createPlaylistName.trim();
    if (!name) {
      setCreatePlaylistError("Enter a playlist name.");
      return;
    }
    setCreatePlaylistBusy(true);
    setCreatePlaylistError(null);
    try {
      if (playlistFormMode === "rename" && editingPlaylistId !== null) {
        await libraryRenamePlaylist(editingPlaylistId, name);
        await refresh();
        setCreatePlaylistOpen(false);
        return;
      }
      const playlist = await libraryCreatePlaylist(name);
      if (createPlaylistTrackId !== null) {
        await libraryAddTrackToPlaylist(playlist.id, createPlaylistTrackId);
      }
      await refresh();
      setSelectedGroup(`${PLAYLIST_PREFIX}${playlist.id}`);
      setCreatePlaylistOpen(false);
    } catch (cause) {
      setCreatePlaylistError(String(cause));
    } finally {
      setCreatePlaylistBusy(false);
    }
  };

  const renamePlaylist = (playlist: Playlist) => {
    setPlaylistMenu(null);
    setPlaylistFormMode("rename");
    setEditingPlaylistId(playlist.id);
    setCreatePlaylistName(playlist.name);
    setCreatePlaylistError(null);
    setCreatePlaylistTrackId(null);
    setCreatePlaylistOpen(true);
  };

  const deletePlaylist = (playlist: Playlist) => {
    if (!window.confirm(`Delete playlist “${playlist.name}”? Tracks in the library will not be removed.`)) return;
    libraryRemovePlaylist(playlist.id)
      .then(() => {
        if (selectedGroup === `${PLAYLIST_PREFIX}${playlist.id}`) setSelectedGroup(FAVORITES_GROUP);
        return refresh();
      })
      .catch((cause) => setError(String(cause)));
    setPlaylistMenu(null);
  };

  const movePlaylistTrack = (trackId: number, direction: -1 | 1) => {
    if (!selectedPlaylist) return;
    const ids = [...selectedPlaylist.track_ids];
    const index = ids.indexOf(trackId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    libraryReorderPlaylist(selectedPlaylist.id, ids).then(refresh).catch((cause) => setError(String(cause)));
    setContextMenu(null);
  };

  const changePlaylistMembership = (playlist: Playlist, trackId: number, included: boolean) => {
    const update = included
      ? libraryAddTrackToPlaylist(playlist.id, trackId)
      : libraryRemoveTrackFromPlaylist(playlist.id, trackId);
    update.then(refresh).catch((cause) => setError(String(cause)));
  };

  const addTracksToPlaylist = (playlistId: number, trackIds: number[]) => {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    void (async () => {
      try {
        let added = 0;
        for (const id of trackIds) {
          if (await libraryAddTrackToPlaylist(playlist.id, id)) added++;
        }
        await refresh();
        setError(added === 0 ? "Those loops are already in this playlist." : null);
      } catch (cause) {
        setError(String(cause));
      }
    })();
  };

  const moveLooperGroup = (sourceHash: string, targetHash: string, insertAfterTarget: boolean) => {
    const hashes = looperGroups.map((group) => group[0].source_hash);
    const sourceIndex = hashes.indexOf(sourceHash);
    const targetIndex = hashes.indexOf(targetHash);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const [moved] = hashes.splice(sourceIndex, 1);
    let insertionIndex = targetIndex + Number(insertAfterTarget);
    if (sourceIndex < insertionIndex) insertionIndex--;
    hashes.splice(insertionIndex, 0, moved);
    libraryReorderLoopers(hashes)
      .then(refresh)
      .catch((cause) => setError(String(cause)));
  };

  const finishInternalDrag = () => {
    if (desktopDragTimer.current !== null) {
      window.clearTimeout(desktopDragTimer.current);
      desktopDragTimer.current = null;
    }
    pointerDrag.current = null;
    internalLibraryDrag.current = false;
    document.documentElement.classList.remove("olooper-library-pointer-drag");
    setDraggingTrackIds([]);
    setDropTarget(null);
    window.dispatchEvent(new Event("olooper:library-internal-drag-end"));
  };

  const startInternalDrag = () => {
    if (internalLibraryDrag.current) return;
    internalLibraryDrag.current = true;
    window.dispatchEvent(new Event("olooper:library-internal-drag-start"));
  };

  const setDragTargetAt = (clientX: number, clientY: number): LibraryDropTarget => {
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const playlist = target?.closest<HTMLElement>("[data-drop-playlist]");
    if (playlist) {
      const playlistId = Number(playlist.dataset.dropPlaylist);
      if (Number.isSafeInteger(playlistId)) return { kind: "playlist", playlistId, element: playlist };
    }
    const favorites = target?.closest<HTMLElement>("[data-drop-favorites]");
    if (favorites) return { kind: "favorites", element: favorites };
    const waveform = target?.closest<HTMLElement>("[data-drop-waveform]");
    if (waveform) return { kind: "waveform", element: waveform };
    const looper = target?.closest<HTMLElement>("[data-drop-looper]");
    if (looper?.dataset.dropLooper) return { kind: "looper", sourceHash: looper.dataset.dropLooper, element: looper };
    return null;
  };

  const updateDragTarget = (target: LibraryDropTarget) => {
    setDropTarget(target);
    window.dispatchEvent(new CustomEvent("olooper:library-drag-hover", {
      detail: { waveform: target?.kind === "waveform" },
    }));
  };

  useEffect(() => {
    const updateCoverDragTarget = (event: Event) => {
      const { playlistId, element } = (event as CustomEvent<{ playlistId: number | null; element: HTMLElement | null }>).detail;
      if (playlistId === null || !element) {
        updateDragTarget(null);
        return;
      }
      if (Number.isSafeInteger(playlistId)) updateDragTarget({ kind: "playlist", playlistId, element });
    };
    const dropCoverTrack = (event: Event) => {
      const { playlistId, trackId } = (event as CustomEvent<{ playlistId: number; trackId: number }>).detail;
      updateDragTarget(null);
      if (Number.isSafeInteger(playlistId) && Number.isSafeInteger(trackId)) {
        addTracksToPlaylist(playlistId, [trackId]);
      }
    };
    window.addEventListener("olooper:cover-library-drag-hover", updateCoverDragTarget);
    window.addEventListener("olooper:cover-library-drag-drop", dropCoverTrack);
    return () => {
      window.removeEventListener("olooper:cover-library-drag-hover", updateCoverDragTarget);
      window.removeEventListener("olooper:cover-library-drag-drop", dropCoverTrack);
    };
  }, [playlists]);

  const beginTrackPointerDrag = (event: React.PointerEvent<HTMLDivElement>, track: Track) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button,input")) return;
    document.documentElement.classList.add("olooper-library-pointer-drag");
    const trackIds = selectedIds.includes(track.id)
      ? selectedTracks.filter((item) => selectedIds.includes(item.id)).map((item) => item.id)
      : [track.id];
    pointerDrag.current = {
      kind: "track",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sourceTrackId: track.id,
      trackIds,
      canDesktopDrag: track.audio_storage === "extracted",
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginLooperPointerDrag = (event: React.PointerEvent<HTMLDivElement>, sourceHash: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-looper-actions]")) return;
    document.documentElement.classList.add("olooper-library-pointer-drag");
    pointerDrag.current = {
      kind: "looper",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sourceHash,
      active: false,
    };
    // Keep a simple click targeted at the nested selection button; capturing
    // on the row wrapper can retarget its click and prevent the button firing.
    const selectionButton = (event.target as HTMLElement).closest("button");
    if (selectionButton && event.currentTarget.contains(selectionButton)) {
      selectionButton.setPointerCapture(event.pointerId);
    } else {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const beginDesktopAudioDrag = async (trackId: number, releasePointerCapture: () => void) => {
    startInternalDrag();
    window.addEventListener("mouseup", finishInternalDrag, { once: true });
    desktopDragTimer.current = window.setTimeout(finishInternalDrag, 30_000);
    try {
      await libraryDragTrackOut(trackId);
    } catch (cause) {
      finishInternalDrag();
      setError(String(cause));
    } finally {
      releasePointerCapture();
    }
  };

  const movePointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.active) {
      drag.active = true;
      startInternalDrag();
      setDraggingTrackIds(drag.kind === "track" ? drag.trackIds : []);
    }

    if (drag.kind === "track" && supportsDesktopDrag && drag.canDesktopDrag) {
      if (
        event.clientX < 0 || event.clientY < 0
        || event.clientX > window.innerWidth
        || event.clientY > window.innerHeight
      ) {
        pointerDrag.current = null;
        setDraggingTrackIds([]);
        updateDragTarget(null);
        const sourceRow = event.currentTarget;
        const pointerId = event.pointerId;
        void beginDesktopAudioDrag(drag.sourceTrackId, () => {
          if (sourceRow.hasPointerCapture(pointerId)) sourceRow.releasePointerCapture(pointerId);
        });
        return;
      }
    }
    updateDragTarget(setDragTargetAt(event.clientX, event.clientY));
  };

  const cancelPointerDrag = () => {
    if (desktopDragTimer.current !== null) return;
    finishInternalDrag();
  };

  const playDraggedTrack = (trackId: number) => {
    window.dispatchEvent(new CustomEvent("olooper:play-library-track", { detail: trackId }));
  };

  const dropPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    document.documentElement.classList.remove("olooper-library-pointer-drag");
    pointerDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.active) {
      updateDragTarget(null);
      return;
    }

    suppressRowClick.current = true;
    window.setTimeout(() => { suppressRowClick.current = false; }, 250);
    const target = setDragTargetAt(event.clientX, event.clientY);
    finishInternalDrag();
    if (drag.kind === "looper") {
      if (target?.kind === "looper") {
        const rect = target.element.getBoundingClientRect();
        moveLooperGroup(drag.sourceHash, target.sourceHash, event.clientY >= rect.top + rect.height / 2);
      }
      return;
    }
    if (target?.kind === "waveform") {
      playDraggedTrack(drag.trackIds[0]);
      return;
    }
    if (target?.kind === "favorites") {
      void (async () => {
        try {
          for (const id of drag.trackIds) {
            const track = tracks.find((item) => item.id === id);
            if (track && !track.favorite) await librarySetFavorite(id, true);
          }
          await refresh();
          setError(null);
        } catch (cause) {
          setError(String(cause));
        }
      })();
      return;
    }
    if (target?.kind === "playlist") {
      addTracksToPlaylist(target.playlistId, drag.trackIds);
    }
  };

  const editTrack = (track: Track) => {
    tapTempoTimes.current = [];
    setTapTempoCount(0);
    setTapTempoEstimate(null);
    setBpmConfirmed(false);
    setMetadataDraft({ title: track.title, bpm: track.bpm?.toString() ?? "", tags: track.tags });
    setMetadataError(null);
    setEditingTrack(track);
    setContextMenu(null);
  };

  const tapTempo = () => {
    const result = recordTempoTap(tapTempoTimes.current, performance.now());
    tapTempoTimes.current = result.taps;
    setTapTempoCount(result.taps.length);
    setTapTempoEstimate(result.bpm);
    if (result.bpm !== null) {
      setBpmConfirmed(true);
      setMetadataDraft((draft) => ({ ...draft, bpm: String(result.bpm) }));
      setMetadataError(null);
    }
  };

  const resetTempoTaps = () => {
    tapTempoTimes.current = [];
    setTapTempoCount(0);
    setTapTempoEstimate(null);
  };

  const saveTrackMetadata = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTrack) return;
    const title = metadataDraft.title.trim();
    if (!title) {
      setMetadataError("Loop title cannot be empty.");
      return;
    }
    const bpmText = metadataDraft.bpm.trim();
    const bpm = bpmText ? Number(bpmText) : editingTrack.bpm;
    if (bpm !== null && (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)) {
      setMetadataError("BPM must be between 20 and 300.");
      return;
    }

    const confirmManualBpm = bpmText.length > 0 && (bpmConfirmed || bpm !== editingTrack.bpm);
    setMetadataBusy(true);
    setMetadataError(null);
    try {
      const updated = await libraryUpdateMetadata(editingTrack.id, title, bpm, metadataDraft.tags.trim(), confirmManualBpm);
      setTracks((current) => current.map((track) => track.id === updated.id ? updated : track));
      setEditingTrack(null);
      if (updated.id === activeTrackId && updated.bpm !== null) {
        window.dispatchEvent(new CustomEvent("olooper:track-bpm", {
          detail: {
            trackId: updated.id,
            bpm: updated.bpm,
            source: updated.bpm_source,
            confidence: updated.bpm_confidence,
          },
        }));
      }
      if (updated.audio_storage === "extracted"
        && updated.bpm !== null
        && (updated.bpm !== editingTrack.bpm || confirmManualBpm)) {
        try {
          await librarySyncSeratoMetadata(editingTrack.id);
        } catch (cause) {
          setError(`Metadata saved in oLooper, but Serato BPM sync failed: ${String(cause)}`);
        }
      }
    } catch (cause) {
      setMetadataError(String(cause));
    } finally {
      setMetadataBusy(false);
    }
  };

  const removeGroup = (sourceHash: string, name: string) => {
    if (!window.confirm(`Remove “${name}” and delete its library audio copies and cover? Original SWF/EXE/source files will be kept.`)) return;
    libraryRemoveLooper(sourceHash).then(refresh).catch((e) => { refresh(); setError(String(e)); });
    setGroupMenu(null);
  };

  const openTrackMenu = (event: React.MouseEvent, trackId: number) => {
    event.preventDefault();
    setPlaylistMenu(null);
    setGroupMenu(null);
    setContextMenu(trackId);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const openGroupMenu = (event: React.MouseEvent, sourceHash: string) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setPlaylistMenu(null);
    setGroupMenu(sourceHash);
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const openPlaylistMenu = (event: React.MouseEvent, playlistId: number) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setGroupMenu(null);
    setPlaylistMenu(playlistId);
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
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">Library</span>
            <span className="text-[10px] tabular-nums text-text-secondary">{tracks.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            <button
              onClick={() => setSelectedGroup(ALL_GROUP)}
              aria-current={selectedGroup === ALL_GROUP ? "page" : undefined}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${selectedGroup === ALL_GROUP ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent/10 text-sm text-accent">▦</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">ALL</span>
              <span className="text-[10px] tabular-nums">{tracks.length}</span>
            </button>
            <button
              onClick={() => setSelectedGroup(FAVORITES_GROUP)}
              data-drop-favorites=""
              aria-current={selectedGroup === FAVORITES_GROUP ? "page" : undefined}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left transition-colors ${dropTarget?.kind === "favorites" ? "bg-accent/25 ring-1 ring-accent" : selectedGroup === FAVORITES_GROUP ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-danger/10 text-sm text-danger">♥</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">Favoritos</span>
              <span className="text-[10px] tabular-nums">{favoritesCount}</span>
            </button>
            <div className="flex items-center justify-between px-2 pb-1 pt-3">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary">Playlists</span>
              <button onClick={() => createPlaylist()} title="Create playlist" aria-label="Create playlist" className="rounded px-1.5 text-sm text-text-secondary hover:bg-border hover:text-text">+</button>
            </div>
            {playlists.map((playlist) => {
              const isSelected = selectedGroup === `${PLAYLIST_PREFIX}${playlist.id}`;
              return (
                <div
                  key={playlist.id}
                  onContextMenu={(event) => openPlaylistMenu(event, playlist.id)}
                  data-drop-playlist={playlist.id}
                  className={`group flex items-center rounded transition-colors ${dropTarget?.kind === "playlist" && dropTarget.playlistId === playlist.id ? "bg-accent/25 ring-1 ring-accent" : isSelected ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
                >
                  <button onClick={() => setSelectedGroup(`${PLAYLIST_PREFIX}${playlist.id}`)} aria-current={isSelected ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-border text-sm">♫</span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{playlist.name}</span>
                    <span className="text-[10px] tabular-nums">{playlist.track_ids.length}</span>
                  </button>
                  <button onClick={(event) => openPlaylistMenu(event, playlist.id)} title={`${playlist.name} actions`} aria-label={`${playlist.name} actions`} className="mr-1 rounded px-1.5 py-1 text-xs text-text-secondary opacity-0 hover:bg-border hover:text-text group-hover:opacity-100 focus:opacity-100">•••</button>
                </div>
              );
            })}
            <div className="px-2 pb-1 pt-3 text-[9px] font-semibold uppercase tracking-wider text-text-secondary">Loopers</div>
            {looperGroups.map((entries) => {
              const sourceHash = entries[0].source_hash;
              const isSelected = selectedGroup === sourceHash;
              return (
                <div
                  key={sourceHash}
                  data-drop-looper={sourceHash}
                  onPointerDown={(event) => beginLooperPointerDrag(event, sourceHash)}
                  onPointerMove={movePointerDrag}
                  onPointerUp={dropPointerDrag}
                  onPointerCancel={cancelPointerDrag}
                  onClick={(event) => {
                    // Pointer capture during reorder can retarget the click to
                    // this wrapper instead of the nested selection button.
                    if (event.target !== event.currentTarget) return;
                    if (suppressRowClick.current) { suppressRowClick.current = false; return; }
                    setSelectedGroup(sourceHash);
                  }}
                  onContextMenu={entries[0].source_type === "custom" ? undefined : (event) => openGroupMenu(event, sourceHash)}
                  className={`group flex select-none items-center rounded transition-colors ${dropTarget?.kind === "looper" && dropTarget.sourceHash === sourceHash ? "bg-accent/25 ring-1 ring-accent" : isSelected ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-hover hover:text-text"}`}
                >
                  <button
                    onClick={() => {
                      if (suppressRowClick.current) { suppressRowClick.current = false; return; }
                      setSelectedGroup(sourceHash);
                    }}
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
                      data-looper-actions=""
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
              {selectedGroup === ALL_GROUP ? "ALL" : selectedPlaylist ? selectedPlaylist.name : selectedGroup === FAVORITES_GROUP ? "Favoritos" : selectedLooper ? groupName(selectedLooper) : "Library"}
            </h2>
            <input aria-label="Search tracks" placeholder="Search loops…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-24 flex-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent" />
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter source" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Source</option><option value="swf">SWF</option><option value="exe">EXE</option><option value="custom">Audio</option><option value="tablist">Tablist</option></select>
            <select value={bpmFilter} onChange={(e) => setBpmFilter(e.target.value)} aria-label="Filter BPM" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">BPM</option><option value="low">&lt;100</option><option value="mid">100–130</option><option value="high">&gt;130</option></select>
            <select value={durationFilter} onChange={(e) => setDurationFilter(e.target.value)} aria-label="Filter duration" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Length</option><option value="short">&lt;10s</option><option value="mid">10–30s</option><option value="long">&gt;30s</option></select>
            <button disabled={selectedIds.length === 0} onClick={exportSelected} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40">Export {selectedIds.length || ""}</button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem] gap-2 border-b border-border bg-elevated/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem]">
            {selectedPlaylist
              ? <span>Playlist order</span>
              : <button
                onClick={() => { setSort("alphabetical"); setBpmDescending(false); }}
                aria-sort={sort === "alphabetical" ? "ascending" : "none"}
                className="truncate text-left hover:text-text"
                title="Sort loops alphabetically"
              >Loop{sort === "alphabetical" ? " ↑" : ""}</button>}
            {selectedPlaylist
              ? <span className="text-right">BPM</span>
              : <button
                onClick={() => {
                  if (sort === "bpm") setBpmDescending((descending) => !descending);
                  else { setSort("bpm"); setBpmDescending(false); }
                }}
                aria-sort={sort === "bpm" ? (bpmDescending ? "descending" : "ascending") : "none"}
                className="text-right hover:text-text"
                title="Sort loops by BPM"
              >BPM{sort === "bpm" ? (bpmDescending ? " ↓" : " ↑") : ""}</button>}
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
                    : selectedPlaylist && selectedPlaylist.track_ids.length === 0
                      ? "This playlist is empty. Add loops from a track's context menu."
                    : "No matches"}
              </p>
            )}
            {selectedTracks.map((track) => (
              <div
                key={track.id}
                data-library-track-id={track.id}
                onPointerDown={(event) => beginTrackPointerDrag(event, track)}
                onPointerMove={movePointerDrag}
                onPointerUp={dropPointerDrag}
                onPointerCancel={cancelPointerDrag}
                onClick={() => {
                  if (suppressRowClick.current) { suppressRowClick.current = false; return; }
                  setActiveId(track.id);
                }}
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
                className={`grid w-full select-none grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem] items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs transition-colors ${track.exists ? "cursor-grab active:cursor-grabbing" : ""} sm:grid-cols-[minmax(0,1fr)_5rem_5rem_5rem] ${draggingTrackIds.includes(track.id) ? "opacity-60" : activeId === track.id ? "bg-accent/10 text-accent" : "text-text hover:bg-surface-hover"} ${!track.exists ? "pointer-events-none opacity-40" : ""}`}
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
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="block min-w-0 truncate font-medium">{track.title}</span>
                        <span className="shrink-0 rounded bg-border/70 px-1 py-0.5 text-[8px] uppercase tracking-wide text-text-secondary">{track.codec}</span>
                        {track.audio_storage === "embedded" && <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[8px] uppercase tracking-wide text-accent">Source</span>}
                      </span>
                      {track.tags && <span className="block truncate text-[10px] text-text-secondary">{track.tags}</span>}
                      {convertingId === track.id && <span className="block text-[9px] text-accent">Converting to MP3 320…</span>}
                  </span>
                </span>
                <span className={`flex items-center justify-end gap-1 text-right text-[11px] tabular-nums ${track.bpm ? "text-success" : "text-text-secondary"}`}>
                  {track.bpm ? `${Math.round(track.bpm)} bpm` : "--"}
                  {track.bpm === null && (
                    <button onClick={(event) => { event.stopPropagation(); editTrack(track); }} title="No BPM estimate; enter it manually" aria-label={`Set BPM for ${track.title}`} className="rounded px-1 text-[9px] text-text-secondary hover:bg-border hover:text-text">Set</button>
                  )}
                  {track.bpm_source === "analyzed" && track.bpm_confidence !== null && track.bpm_confidence < BPM_REVIEW_THRESHOLD && (
                    <button onClick={(event) => { event.stopPropagation(); editTrack(track); }} title={`Low-confidence BPM (${Math.round(track.bpm_confidence * 100)}%). Click to review or correct.`} aria-label={`Review uncertain BPM for ${track.title}`} className="rounded px-1 text-[10px] text-warning hover:bg-warning/10">⚠</button>
                  )}
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
                      const prompt = track.audio_storage === "embedded"
                        ? `Remove “${track.title}” from the library? The copied SWF/EXE source will be kept.`
                        : `Remove “${track.title}” and delete its audio copy from the library? The original source file will be kept.`;
                      if (window.confirm(prompt)) deleteTrack(track.id);
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
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) revealInFileManager(track.file_path).catch((e: unknown) => setError(String(e))); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">{tracks.find((item) => item.id === contextMenu)?.audio_storage === "embedded" ? "Reveal source copy" : "Reveal audio file"}</button>
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) toggleFavorite(track); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">{tracks.find((item) => item.id === contextMenu)?.favorite ? "Remove favorite" : "Add favorite"}</button>
          <button onClick={() => { setPlaylistTrackId(contextMenu); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Add to playlist…</button>
          {tracks.find((item) => item.id === contextMenu)?.audio_storage === "extracted"
            && tracks.find((item) => item.id === contextMenu)?.codec.toLowerCase() === "wav" && (
            <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) void convertWavToMp3(track); }} disabled={convertingId === contextMenu} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover disabled:opacity-40">Convert WAV to MP3 (320 kbps)…</button>
          )}
          {selectedPlaylist && (
            <>
              <button onClick={() => movePlaylistTrack(contextMenu, -1)} disabled={selectedPlaylist.track_ids.indexOf(contextMenu) <= 0} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover disabled:opacity-40">Move earlier in playlist</button>
              <button onClick={() => movePlaylistTrack(contextMenu, 1)} disabled={selectedPlaylist.track_ids.indexOf(contextMenu) < 0 || selectedPlaylist.track_ids.indexOf(contextMenu) >= selectedPlaylist.track_ids.length - 1} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover disabled:opacity-40">Move later in playlist</button>
              <button onClick={() => { changePlaylistMembership(selectedPlaylist, contextMenu, false); setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Remove from this playlist</button>
            </>
          )}
          <button onClick={() => { const track = tracks.find((item) => item.id === contextMenu); if (track) editTrack(track); else setContextMenu(null); }} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Edit metadata</button>
          <button
            onClick={() => {
              const track = tracks.find((item) => item.id === contextMenu);
              const prompt = track?.audio_storage === "embedded"
                ? `Remove “${track.title}” from the library? The copied SWF/EXE source will be kept.`
                : `Remove “${track?.title}” and delete its audio copy from the library? The original source file will be kept.`;
              if (track && window.confirm(prompt)) {
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
      {playlistMenu !== null && (() => {
        const playlist = playlists.find((item) => item.id === playlistMenu);
        if (!playlist) return null;
        return (
          <div className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl" style={{ left: Math.min(menuPosition.x, window.innerWidth - 200), top: Math.min(menuPosition.y, window.innerHeight - 100) }} onClick={(event) => event.stopPropagation()}>
            <button onClick={() => renamePlaylist(playlist)} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">Rename playlist</button>
            <button onClick={() => deletePlaylist(playlist)} className="w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/10">Delete playlist</button>
          </div>
        );
      })()}
      {playlistTrackId !== null && (() => {
        const track = tracks.find((item) => item.id === playlistTrackId);
        if (!track) return null;
        return (
          <div className="fixed inset-0 z-[105] flex items-center justify-center bg-app/75 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setPlaylistTrackId(null); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="playlist-membership-title" className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-2xl">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="playlist-membership-title" className="text-sm font-semibold text-text">Add to playlist</h2>
                  <p className="mt-1 truncate text-[10px] text-text-secondary" title={track.title}>{track.title}</p>
                </div>
                <button onClick={() => setPlaylistTrackId(null)} aria-label="Close" className="rounded px-2 py-1 text-text-secondary hover:bg-border">×</button>
              </div>
              {playlists.length === 0
                ? <p className="py-3 text-xs text-text-secondary">Create a playlist to collect this loop.</p>
                : <div className="max-h-64 space-y-1 overflow-y-auto">{playlists.map((playlist) => (
                  <label key={playlist.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs text-text hover:bg-surface-hover">
                    <input type="checkbox" checked={playlist.track_ids.includes(track.id)} onChange={(event) => changePlaylistMembership(playlist, track.id, event.target.checked)} />
                    <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                    <span className="text-[10px] text-text-secondary">{playlist.track_ids.length}</span>
                  </label>
                ))}</div>}
              <div className="mt-4 flex justify-between">
                <button onClick={() => createPlaylist(track.id)} className="rounded bg-border px-3 py-2 text-xs text-text hover:bg-surface-hover">New playlist</button>
                <button onClick={() => setPlaylistTrackId(null)} className="rounded bg-accent px-3 py-2 text-xs font-medium text-white">Done</button>
              </div>
            </section>
          </div>
        );
      })()}
      {createPlaylistOpen && (
        <div className="fixed inset-0 z-[108] flex items-center justify-center bg-app/75 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !createPlaylistBusy) { setCreatePlaylistOpen(false); setCreatePlaylistTrackId(null); } }}>
          <form role="dialog" aria-modal="true" aria-labelledby="create-playlist-title" onSubmit={(event) => void submitPlaylistCreation(event)} className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 id="create-playlist-title" className="mb-3 text-sm font-semibold text-text">{playlistFormMode === "rename" ? "Rename playlist" : "Create playlist"}</h2>
            <label className="block text-xs text-text-secondary">
              Name
              <input autoFocus value={createPlaylistName} onChange={(event) => setCreatePlaylistName(event.target.value)} disabled={createPlaylistBusy} className="mt-1 block w-full rounded border border-border bg-elevated px-2.5 py-2 text-sm text-text" />
            </label>
            {createPlaylistError && <p className="mt-2 text-xs text-danger" role="alert">{createPlaylistError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => { setCreatePlaylistOpen(false); setCreatePlaylistTrackId(null); }} disabled={createPlaylistBusy} className="rounded bg-border px-3 py-2 text-xs text-text-secondary hover:text-text disabled:opacity-40">Cancel</button>
              <button type="submit" disabled={createPlaylistBusy || !createPlaylistName.trim()} className="rounded bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40">{createPlaylistBusy ? "Saving…" : playlistFormMode === "rename" ? "Save" : "Create"}</button>
            </div>
          </form>
        </div>
      )}
      {editingTrack && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-app/75 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !metadataBusy) setEditingTrack(null);
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-track-metadata-title"
            onSubmit={(event) => void saveTrackMetadata(event)}
            className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-2xl"
          >
            <h2 id="edit-track-metadata-title" className="mb-4 text-base font-semibold text-text">Edit metadata</h2>
            <label className="mb-3 block text-xs text-text-secondary">
              Loop title
              <input
                autoFocus
                value={metadataDraft.title}
                onChange={(event) => setMetadataDraft((draft) => ({ ...draft, title: event.target.value }))}
                disabled={metadataBusy}
                className="mt-1 block w-full rounded border border-border bg-elevated px-2.5 py-2 text-sm text-text disabled:opacity-50"
              />
            </label>
            <label className="mb-3 block text-xs text-text-secondary">
              BPM <span className="text-text-secondary/70">(leave empty to keep current)</span>
              <input
                type="number"
                min={20}
                max={300}
                step="any"
                value={metadataDraft.bpm}
                onChange={(event) => {
                  resetTempoTaps();
                  setBpmConfirmed(true);
                  setMetadataDraft((draft) => ({ ...draft, bpm: event.target.value }));
                }}
                disabled={metadataBusy}
                className="mt-1 block w-full rounded border border-border bg-elevated px-2.5 py-2 text-sm text-text disabled:opacity-50"
              />
              {editingTrack.bpm_source === "analyzed" && editingTrack.bpm_confidence !== null && editingTrack.bpm_confidence < BPM_REVIEW_THRESHOLD && (
                <span className="mt-1 block text-[10px] text-warning">Low-confidence estimate ({Math.round(editingTrack.bpm_confidence * 100)}%). Adjust it here if needed.</span>
              )}
            </label>
            <div className="-mt-2 mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={tapTempo}
                disabled={metadataBusy}
                aria-label="Tap tempo"
                className="rounded bg-accent/15 px-2.5 py-1.5 text-[10px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
              >Tap tempo</button>
              <span className="text-[10px] text-text-secondary" role="status" aria-live="polite">
                {tapTempoEstimate !== null
                  ? `${tapTempoEstimate} BPM estimate · tap to refine`
                  : `${Math.min(tapTempoCount, 4)} / 4 taps`}
              </span>
              {tapTempoCount > 0 && (
                <button type="button" onClick={resetTempoTaps} disabled={metadataBusy} className="ml-auto text-[10px] text-text-secondary hover:text-text disabled:opacity-40">Reset taps</button>
              )}
            </div>
            <label className="mb-4 block text-xs text-text-secondary">
              Tags <span className="text-text-secondary/70">(comma separated)</span>
              <input
                value={metadataDraft.tags}
                onChange={(event) => setMetadataDraft((draft) => ({ ...draft, tags: event.target.value }))}
                disabled={metadataBusy}
                className="mt-1 block w-full rounded border border-border bg-elevated px-2.5 py-2 text-sm text-text disabled:opacity-50"
              />
            </label>
            {metadataError && <p className="mb-3 text-xs text-danger" role="alert">{metadataError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingTrack(null)}
                disabled={metadataBusy}
                className="rounded bg-border px-3 py-2 text-xs text-text-secondary hover:text-text disabled:opacity-40"
              >Cancel</button>
              <button
                type="submit"
                disabled={metadataBusy}
                className="rounded bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              >{metadataBusy ? "Saving…" : "Save metadata"}</button>
            </div>
          </form>
        </div>
      )}
      {error && <div className="border-t border-danger/30 px-3 py-1.5 text-[10px] text-danger" role="alert">{error}</div>}
    </aside>
  );
}
