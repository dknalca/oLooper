import { useEffect, useRef, useState, type Ref } from "react";
import {
  playerSeek,
  playerSetLoopSnapped,
  type PlayerStatus,
  type SeratoCue,
  type WaveformData,
} from "../tauri";
import Logo from "./Logo";
import { waveformWindowStart } from "../waveformRender";
import { useWaveformPeaks } from "../hooks/useWaveformPeaks";
import { useWaveformDrawing } from "../hooks/useWaveformDrawing";

interface Props {
  renderingPaused?: boolean;
  status: PlayerStatus | null;
  trackTitle: string | null;
  trackCover: string | null;
  coverRef?: Ref<HTMLDivElement>;
  trackId: number | null;
  playbackPath?: string | null;
  showCover: boolean;
  loopEditing: boolean;
  onStatusChange: (status: PlayerStatus) => void;
}

export default function Waveform({ status, trackTitle, trackCover, coverRef, trackId, playbackPath, showCover, loopEditing, onStatusChange, renderingPaused = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<PlayerStatus | null>(null);
  const waveRef = useRef<WaveformData | null>(null);
  const waveTrackIdRef = useRef<number | null>(null);
  const wavePathRef = useRef<string | null>(null);
  const trackIdRef = useRef(trackId);
  trackIdRef.current = trackId;
  const cuesRef = useRef<SeratoCue[]>([]);
  const zoomRef = useRef(1);
  const previewRef = useRef<{ start: number; end: number } | null>(null);
  const coverPointerDragRef = useRef<{ trackId: number; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  const loopEditingRef = useRef(loopEditing);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const [trackDropActive, setTrackDropActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; time: number } | null>(null);
  const loadedPath = !playbackPath || status?.path === playbackPath ? status?.path ?? null : null;
  const redraw = useWaveformDrawing({ paused: renderingPaused, canvasRef, statusRef, waveRef, waveTrackIdRef, wavePathRef, trackIdRef, cuesRef, zoomRef, previewRef, loopEditingRef });

  useEffect(() => {
    const updateLibraryDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ waveform: boolean }>).detail;
      setTrackDropActive(detail.waveform);
    };
    const endLibraryDrag = () => setTrackDropActive(false);
    window.addEventListener("olooper:library-drag-hover", updateLibraryDrag);
    window.addEventListener("olooper:library-internal-drag-end", endLibraryDrag);
    return () => {
      window.removeEventListener("olooper:library-drag-hover", updateLibraryDrag);
      window.removeEventListener("olooper:library-internal-drag-end", endLibraryDrag);
    };
  }, []);

  useEffect(() => {
    statusRef.current = status;
    redraw();
  }, [status, redraw]);

  useEffect(() => {
    waveRef.current = null;
    waveTrackIdRef.current = null;
    wavePathRef.current = null;
    setError(null);
    setGenerating(false);
    setDragging(null);
    previewRef.current = null;
  }, [trackId, loadedPath, status?.generation]);

  useEffect(() => { zoomRef.current = zoom; redraw(); }, [zoom, redraw]);

  useEffect(() => {
    loopEditingRef.current = loopEditing;
    if (!loopEditing) {
      previewRef.current = null;
      setDragging(null);
    }
    redraw();
  }, [loopEditing, redraw]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    const setCues = (event: Event) => { cuesRef.current = (event as CustomEvent<SeratoCue[]>).detail; redraw(); };
    window.addEventListener("olooper:cues", setCues);
    return () => window.removeEventListener("olooper:cues", setCues);
  }, [redraw]);

  useWaveformPeaks({ loadedPath, loading: status?.loading, generation: status?.generation, zoom, trackId, wrapRef,
    waveRef, waveTrackIdRef, wavePathRef, setGenerating, setError, onReady: redraw });

  const timeAtPointer = (e: { clientX: number }) => {
    const canvas = canvasRef.current;
    const st = statusRef.current;
    const wave = waveRef.current;
    if (!canvas || !st?.loaded || st.loading || !wave
      || waveTrackIdRef.current !== trackIdRef.current || wavePathRef.current !== st.path) return null;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoomRef.current));
    const start = waveformWindowStart(st.position_ms, wave.duration_ms, view);
    return Math.round(start + frac * view);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const time = timeAtPointer(e);
    const canvas = canvasRef.current;
    const st = statusRef.current;
    const wave = waveRef.current;
    if (time === null || !canvas || !st || !wave) return;
    if (loopEditing) {
      const rect = canvas.getBoundingClientRect();
      const view = Math.min(wave.duration_ms, Math.max(20, wave.duration_ms / zoomRef.current));
      const start = waveformWindowStart(st.position_ms, wave.duration_ms, view);
      const xOf = (ms: number) => ((ms - start) / view) * rect.width;
      const pointerX = e.clientX - rect.left;
      const startDistance = Math.abs(pointerX - xOf(st.loop_start_ms));
      const endDistance = Math.abs(pointerX - xOf(st.loop_end_ms));
      const boundary = Math.min(startDistance, endDistance) <= 12
        ? (startDistance <= endDistance ? "start" : "end")
        : null;
      if (boundary) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        previewRef.current = { start: st.loop_start_ms, end: st.loop_end_ms };
        setDragging(boundary);
        redraw();
        return;
      }
    }
    playerSeek(time).then(onStatusChange).catch((err) => setError(String(err)));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const time = timeAtPointer(e);
    if (time === null) return;
    const preview = { ...previewRef.current };
    if (dragging === "start") preview.start = Math.max(0, Math.min(time, preview.end - 1));
    else preview.end = Math.min(statusRef.current?.duration_ms ?? time, Math.max(time, preview.start + 1));
    previewRef.current = preview;
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !previewRef.current) return;
    const preview = previewRef.current;
    previewRef.current = null;
    setDragging(null);
    redraw();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    playerSetLoopSnapped(preview.start, preview.end, statusRef.current?.generation)
      .then(onStatusChange)
      .catch((reason: unknown) => setError(String(reason)));
  };

  const openWaveformMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const time = timeAtPointer(event);
    if (time === null) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, time });
  };

  const seekFromMenu = (time: number) => {
    setContextMenu(null);
    playerSeek(time).then(onStatusChange).catch((reason: unknown) => setError(String(reason)));
  };

  const copyTimeFromMenu = async (time: number) => {
    setContextMenu(null);
    try {
      await navigator.clipboard.writeText(`${(time / 1000).toFixed(2)} s`);
    } catch (reason) {
      setError(`Could not copy time: ${String(reason)}`);
    }
  };

  const coverPlaylistAt = (clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-drop-playlist]");
    const playlistId = Number(target?.dataset.dropPlaylist);
    return target && Number.isSafeInteger(playlistId) ? { playlistId, element: target } : null;
  };

  const startCoverPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || trackId === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    coverPointerDragRef.current = {
      trackId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const moveCoverPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = coverPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.active) {
      drag.active = true;
      document.documentElement.classList.add("olooper-library-pointer-drag");
      window.dispatchEvent(new Event("olooper:library-internal-drag-start"));
    }
    const target = coverPlaylistAt(event.clientX, event.clientY);
    window.dispatchEvent(new CustomEvent("olooper:cover-library-drag-hover", {
      detail: { playlistId: target?.playlistId ?? null, element: target?.element ?? null },
    }));
  };

  const finishCoverPointerDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = coverPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    coverPointerDragRef.current = null;
    if (drag.active) {
      const target = cancelled ? null : coverPlaylistAt(event.clientX, event.clientY);
      window.dispatchEvent(new CustomEvent("olooper:cover-library-drag-hover", {
        detail: { playlistId: null, element: null },
      }));
      if (target) {
        window.dispatchEvent(new CustomEvent("olooper:cover-library-drag-drop", {
          detail: { playlistId: target.playlistId, trackId: drag.trackId },
        }));
      }
      document.documentElement.classList.remove("olooper-library-pointer-drag");
      window.dispatchEvent(new Event("olooper:library-internal-drag-end"));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div data-drop-waveform="" className={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-elevated ${trackDropActive ? "border-accent ring-2 ring-accent/30" : "border-border"}`}>
      {trackDropActive && <div className="pointer-events-none absolute inset-0 z-[80] flex items-center justify-center bg-accent/10 text-sm font-medium text-accent">Drop to play this loop</div>}
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {showCover && (
          <div
            ref={coverRef}
            onPointerDown={startCoverPointerDrag}
            onPointerMove={moveCoverPointerDrag}
            onPointerUp={finishCoverPointerDrag}
            onPointerCancel={(event) => finishCoverPointerDrag(event, true)}
            title="Drag this loop to a playlist"
            className="relative aspect-square w-[clamp(5rem,16vh,8rem)] max-w-[28%] shrink-0 self-center touch-none overflow-hidden rounded-md border border-border bg-surface select-none cursor-grab active:cursor-grabbing"
          >
            {trackCover
              ? <img src={trackCover} alt={trackTitle ? `Cover for ${trackTitle}` : "Looper cover"} className="pointer-events-none h-full w-full object-cover" />
              : <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-text-secondary/60"><Logo className="h-8 w-8 opacity-60" /><span className="text-[9px]">No cover</span></div>}
            {trackTitle && <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-app/75 px-2 py-1 text-[9px] font-medium text-text" title={trackTitle}>{trackTitle}</span>}
          </div>
        )}
        <div ref={wrapRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg bg-app">
          <div className="absolute right-2 top-2 z-10 flex gap-1">
            <button aria-label="Zoom out waveform" disabled={!loadedPath || zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value / 2))} className="rounded bg-elevated px-2 py-1 text-xs text-text disabled:opacity-40">−</button>
            <button aria-label="Zoom in waveform" disabled={!loadedPath || zoom >= 32} onClick={() => setZoom((value) => Math.min(32, value * 2))} className="rounded bg-elevated px-2 py-1 text-xs text-text disabled:opacity-40">+</button>
            <button aria-label="Fit waveform to view" disabled={!loadedPath} onClick={() => setZoom(1)} className="rounded bg-elevated px-2 py-1 text-[10px] text-text disabled:opacity-40">Fit</button>
          </div>
          {!loadedPath && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-text-secondary pointer-events-none">
              <Logo className="h-9 w-9 opacity-70" />
              <span className="text-sm font-medium text-text">Find your next groove</span>
              <span>Play a track below or drag one here to start practicing.</span>
            </div>
          )}
          {status?.loaded && trackTitle && (
            <div className="pointer-events-none absolute left-3 top-2 z-10 max-w-[65%] truncate rounded bg-app/75 px-2 py-1 text-[11px] font-medium text-text shadow-sm" title={trackTitle}>
              {trackTitle}
            </div>
          )}
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onContextMenu={openWaveformMenu}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { previewRef.current = null; setDragging(null); redraw(); }}
            className={`h-full w-full ${loopEditing ? "cursor-col-resize" : "cursor-crosshair"}`}
          />
        {contextMenu && status?.loaded && (
          <div
            className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
          }}
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => seekFromMenu(contextMenu.time)} className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover">
              Seek to {(contextMenu.time / 1000).toFixed(2)}s
            </button>
            <button
              onClick={() => void copyTimeFromMenu(contextMenu.time)}
              className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover"
            >
              Copy time
            </button>
          </div>
        )}
        {generating && (
          <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-elevated/90 px-2 py-0.5 text-[10px] text-warning">
            Generating waveform…
          </div>
        )}
        </div>
      </div>
      {error && (
        <div className="px-3 py-1 text-[10px] text-danger border-t border-border" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
