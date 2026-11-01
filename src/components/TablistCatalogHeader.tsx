import { TABLIST_PAGE_SIZE } from "../tablistCatalog";
import LibraryViewTabs, { type LibraryView } from "./LibraryViewTabs";

interface Props {
  libraryReady: boolean;
  search: string;
  pageNumber: number;
  resultCount: number;
  total: number;
  loading: boolean;
  randomLoading: boolean;
  activeLooper: string | null;
  onLibraryViewChange: (view: LibraryView) => void;
  onSearch: (value: string) => void;
  onRandom: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

/** Catalog search and pagination; the parent owns requests and cancellation. */
export default function TablistCatalogHeader({ libraryReady, search, pageNumber, resultCount, total, loading, randomLoading, activeLooper, onLibraryViewChange, onSearch, onRandom, onPrevious, onNext }: Props) {
  const firstItem = total === 0 ? 0 : pageNumber * TABLIST_PAGE_SIZE + 1;
  const lastItem = Math.min(pageNumber * TABLIST_PAGE_SIZE + resultCount, total);
  const pageCount = Math.max(1, Math.ceil(total / TABLIST_PAGE_SIZE));
  return <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
    <LibraryViewTabs selected="tablist" onSelect={onLibraryViewChange} className="w-52 shrink-0" />
    <input type="search" aria-label="Search Tablist loopers" placeholder="Search loopers, artists, tags…" value={search}
      onChange={(event) => onSearch(event.target.value)} disabled={activeLooper !== null || randomLoading}
      className="min-w-24 flex-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent focus:outline-none disabled:opacity-50" />
    <button onClick={onRandom} disabled={!libraryReady || activeLooper !== null || randomLoading || loading}
      className="shrink-0 rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent/80 disabled:opacity-40">
      {randomLoading ? "Buscando looper…" : "Descargar Random Looper"}
    </button>
    <span className="shrink-0 text-[10px] text-text-secondary">{loading ? "Loading…" : `${firstItem}–${lastItem} / ${total}`}</span>
    <button onClick={onPrevious} disabled={loading || randomLoading || pageNumber === 0 || activeLooper !== null}
      aria-label="Previous catalog page" className="rounded bg-elevated px-2 py-1 text-xs text-text-secondary hover:text-text disabled:opacity-30">‹</button>
    <span className="text-[10px] tabular-nums text-text-secondary">{pageNumber + 1}/{pageCount}</span>
    <button onClick={onNext} disabled={loading || randomLoading || pageNumber + 1 >= pageCount || activeLooper !== null}
      aria-label="Next catalog page" className="rounded bg-elevated px-2 py-1 text-xs text-text-secondary hover:text-text disabled:opacity-30">›</button>
  </div>;
}
