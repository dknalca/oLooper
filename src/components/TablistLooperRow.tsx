import type { ImportProgress, TablistCatalogLooper } from "../tauri";
import { isTablistLooperDownloaded, tablistRouteKey } from "../tablistCatalog";

interface Props {
  looper: TablistCatalogLooper;
  counts: Record<string, number>;
  libraryReady: boolean;
  activeLooper: string | null;
  randomLoading: boolean;
  progress: ImportProgress | null;
  onImport: (looper: TablistCatalogLooper) => void;
  onContextMenu: (looper: TablistCatalogLooper, x: number, y: number) => void;
}

/** Render a catalog item; import ownership and job state remain in the parent. */
export default function TablistLooperRow({ looper, counts, libraryReady, activeLooper, randomLoading, progress, onImport, onContextMenu }: Props) {
  const busy = activeLooper === looper.path;
  const imported = counts[tablistRouteKey(looper.path)] ?? 0;
  const downloaded = isTablistLooperDownloaded(looper, counts);
  const partial = imported > 0 && !downloaded;
  return <div
    onDoubleClick={() => onImport(looper)}
    onContextMenu={(event) => { event.preventDefault(); onContextMenu(looper, event.clientX, event.clientY); }}
    onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) onImport(looper); }}
    role="group" aria-label={`${looper.title}, ${looper.loops.length} loops`} title={`${looper.title} — double-click to download all tracks`}
    className="grid w-full grid-cols-[minmax(0,1fr)_minmax(9rem,1.5fr)_4rem_6rem_5rem] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left text-xs text-text transition-colors hover:bg-surface-hover">
    <span className="min-w-0"><span className="block truncate font-medium">{looper.title}</span><span className="block truncate text-[10px] text-text-secondary">{looper.path}</span></span>
    <span className="min-w-0 truncate text-[10px] text-text-secondary" title={looper.tags.join(", ")}>{looper.tags.join(" · ") || "—"}</span>
    <span className="text-right tabular-nums text-text-secondary">{looper.loops.length}</span>
    <span className="text-right text-[10px] tabular-nums text-text-secondary">{looper.date || "—"}</span>
    <span className="flex justify-end">
      <button type="button" onClick={(event) => { event.stopPropagation(); onImport(looper); }} onDoubleClick={(event) => event.stopPropagation()}
        disabled={!libraryReady || activeLooper !== null || randomLoading || downloaded}
        aria-label={`Download all tracks from ${looper.title}`}
        className={`rounded px-2 py-1 text-[10px] font-medium disabled:opacity-50 ${downloaded ? "bg-success/20 text-success" : partial ? "bg-warning/15 text-warning hover:bg-warning/25" : "bg-accent/15 text-accent hover:bg-accent/25"}`}>
        {busy ? "Downloading…" : downloaded ? "Downloaded" : partial ? "Resume" : "Download"}
      </button>
    </span>
    {busy && <span className="col-span-5 text-[10px] text-accent">{progress?.stage ?? "Preparing Tablist import"}</span>}
  </div>;
}
