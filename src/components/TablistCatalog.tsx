import { useEffect, useRef, useState } from "react";
import {
  cancelImport,
  importTablistAndWait,
  listenImportProgress,
  tablistSearch,
  type ImportProgress,
  type TablistCatalogLooper,
} from "../tauri";

interface Props {
  libraryReady: boolean;
  onImported: () => void;
}

const PAGE_SIZE = 24;

export default function TablistCatalog({ libraryReady, onImported }: Props) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(0);
  const [results, setResults] = useState<TablistCatalogLooper[]>([]);
  const [total, setTotal] = useState(0);
  const [skippedPaths, setSkippedPaths] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLooper, setActiveLooper] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const activeJobId = useRef<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPageNumber(0);
      setQuery(searchInput.trim());
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    tablistSearch(query, pageNumber * PAGE_SIZE)
      .then((page) => {
        if (cancelled) return;
        setResults(page.hits);
        setTotal(page.estimatedTotalHits);
        setSkippedPaths(page.skippedInvalidPaths);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [query, pageNumber]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenImportProgress((next) => {
      if (next.job_id === activeJobId.current) setProgress(next);
    }).then((off) => { unlisten = off; }).catch((reason: unknown) => setError(String(reason)));
    return () => unlisten?.();
  }, []);

  const importLooper = async (looper: TablistCatalogLooper) => {
    if (!libraryReady || activeLooper !== null) return;
    const jobId = crypto.randomUUID();
    activeJobId.current = jobId;
    setActiveLooper(looper.path);
    setProgress(null);
    setImportError(null);
    try {
      const url = new URL(looper.path, "https://tablist.net/").toString();
      const reports = await importTablistAndWait(url, jobId);
      const failed = reports.filter((report) => !report.added && report.error !== "already in library");
      const added = reports.filter((report) => report.added).length;
      const existing = reports.filter((report) => report.error === "already in library").length;
      if (failed.length > 0) {
        setImportError(`${failed.length} track(s) failed: ${failed[0].error}`);
      } else {
        setImportError(`${added} added${existing ? `, ${existing} already in library` : ""}`);
      }
      onImported();
    } catch (reason) {
      setImportError(String(reason));
    } finally {
      activeJobId.current = null;
      setActiveLooper(null);
      setProgress(null);
    }
  };

  const cancel = () => {
    const jobId = activeJobId.current;
    if (jobId) cancelImport(jobId).catch((reason: unknown) => setImportError(String(reason)));
  };

  const firstItem = total === 0 ? 0 : pageNumber * PAGE_SIZE + 1;
  const lastItem = Math.min(pageNumber * PAGE_SIZE + results.length, total);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="shrink-0 text-xs font-medium uppercase tracking-wider text-text-secondary">Tablist catalog</span>
        <input
          type="search"
          aria-label="Search Tablist loopers"
          placeholder="Search loopers, artists, tags…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          disabled={activeLooper !== null}
          className="min-w-0 flex-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <span className="shrink-0 text-[10px] text-text-secondary">{loading ? "Loading…" : `${firstItem}–${lastItem} / ${total}`}</span>
        <button
          onClick={() => setPageNumber((page) => Math.max(0, page - 1))}
          disabled={loading || pageNumber === 0 || activeLooper !== null}
          aria-label="Previous catalog page"
          className="rounded bg-elevated px-2 py-1 text-xs text-text-secondary hover:text-text disabled:opacity-30"
        >
          ‹
        </button>
        <span className="text-[10px] tabular-nums text-text-secondary">{pageNumber + 1}/{pageCount}</span>
        <button
          onClick={() => setPageNumber((page) => page + 1)}
          disabled={loading || pageNumber + 1 >= pageCount || activeLooper !== null}
          aria-label="Next catalog page"
          className="rounded bg-elevated px-2 py-1 text-xs text-text-secondary hover:text-text disabled:opacity-30"
        >
          ›
        </button>
      </div>

      {!libraryReady && (
        <p className="border-b border-warning/30 bg-warning/5 px-4 py-2 text-[10px] text-warning">
          Choose a library folder before importing loopers. You can still browse the catalog.
        </p>
      )}
      {activeLooper && (
        <div className="flex items-center gap-3 border-b border-accent/30 bg-accent/5 px-4 py-2 text-[10px]">
          <span className="min-w-0 flex-1 truncate text-accent">
            {progress?.stage ?? "Preparing Tablist import"}
            {progress && progress.total > 0 ? ` ${progress.current}/${progress.total}` : ""}
            {progress?.detail ? ` · ${progress.detail}` : ""}
          </span>
          <button onClick={cancel} className="text-danger hover:text-danger/80">Cancel</button>
        </div>
      )}
      {importError && (
        <p role="status" className="border-b border-border px-4 py-2 text-[10px] text-text-secondary">{importError}</p>
      )}
      {skippedPaths > 0 && (
        <p className="border-b border-warning/30 px-4 py-1.5 text-[10px] text-warning">
          Skipped {skippedPaths} catalog entr{skippedPaths === 1 ? "y" : "ies"} with unsupported routes.
        </p>
      )}
      {error && <p role="alert" className="border-b border-danger/30 px-4 py-2 text-[10px] text-danger">{error}</p>}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,1.5fr)_4rem_6rem] gap-3 border-b border-border bg-elevated/50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        <span>Looper</span>
        <span>Artists / tags</span>
        <span className="text-right">Loops</span>
        <span className="text-right">Added</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && results.length === 0 && <p className="px-4 py-8 text-center text-xs text-text-secondary">Loading Tablist catalog…</p>}
        {!loading && !error && results.length === 0 && <p className="px-4 py-8 text-center text-xs text-text-secondary">No loopers found.</p>}
        {results.map((looper) => {
          const busy = activeLooper === looper.path;
          return (
            <button
              key={looper.nid || looper.path}
              type="button"
              onDoubleClick={() => void importLooper(looper)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importLooper(looper);
              }}
              disabled={!libraryReady || activeLooper !== null}
              title={`${looper.title} — double-click to download all tracks`}
              className="grid w-full grid-cols-[minmax(0,1fr)_minmax(9rem,1.5fr)_4rem_6rem] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left text-xs text-text transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{looper.title}</span>
                <span className="block truncate text-[10px] text-text-secondary">{looper.path}</span>
              </span>
              <span className="min-w-0 truncate text-[10px] text-text-secondary" title={looper.tags.join(", ")}>
                {looper.tags.join(" · ") || "—"}
              </span>
              <span className="text-right tabular-nums text-text-secondary">{looper.loops.length}</span>
              <span className="text-right text-[10px] tabular-nums text-text-secondary">{looper.date || "—"}</span>
              {busy && <span className="col-span-4 text-[10px] text-accent">Downloading…</span>}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between border-t border-border px-3 py-1.5 text-[10px] text-text-secondary">
        <span>{total} public looper{total === 1 ? "" : "s"}</span>
        <span>Double-click a looper to import all of its tracks</span>
      </div>
    </aside>
  );
}
