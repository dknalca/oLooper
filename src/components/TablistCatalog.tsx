import { useEffect, useRef, useState } from "react";
import {
  cancelImport,
  importTablistAndWait,
  libraryTablistImportCounts,
  listenImportProgress,
  tablistSearch,
  type ImportProgress,
  type TablistCatalogLooper,
  type TablistImportCount,
} from "../tauri";

interface Props {
  libraryReady: boolean;
  refreshKey: number;
  onImported: () => void;
}

const PAGE_SIZE = 24;

function routeKey(pathOrUrl: string): string {
  try {
    const url = new URL(pathOrUrl, "https://tablist.net/");
    if (url.hostname === "tablist.net" || url.hostname === "www.tablist.net") {
      return url.pathname.replace(/^\/+|\/+$/g, "");
    }
  } catch {
    // Fall back to the normalized catalog path below.
  }
  return pathOrUrl.replace(/^\/+|\/+$/g, "").split(/[?#]/, 1)[0];
}

interface CatalogContextMenu {
  looper: TablistCatalogLooper;
  x: number;
  y: number;
}

export default function TablistCatalog({ libraryReady, refreshKey, onImported }: Props) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(0);
  const [results, setResults] = useState<TablistCatalogLooper[]>([]);
  const [total, setTotal] = useState(0);
  const [skippedPaths, setSkippedPaths] = useState(0);
  const [importCounts, setImportCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [randomLoading, setRandomLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLooper, setActiveLooper] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [contextMenu, setContextMenu] = useState<CatalogContextMenu | null>(null);
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
    if (!libraryReady) {
      setImportCounts({});
      return;
    }
    let cancelled = false;
    libraryTablistImportCounts()
      .then((counts: TablistImportCount[]) => {
        if (cancelled) return;
        const byRoute: Record<string, number> = {};
        for (const item of counts) {
          const key = routeKey(item.source_path);
          byRoute[key] = (byRoute[key] ?? 0) + item.tracks;
        }
        setImportCounts(byRoute);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => { cancelled = true; };
  }, [libraryReady, refreshKey]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenImportProgress((next) => {
      if (next.job_id === activeJobId.current) setProgress(next);
    }).then((off) => { unlisten = off; }).catch((reason: unknown) => setError(String(reason)));
    return () => unlisten?.();
  }, []);

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

  const importLooper = async (looper: TablistCatalogLooper, fromRandom = false) => {
    if (!libraryReady || activeLooper !== null || (randomLoading && !fromRandom)) return;
    const imported = importCounts[routeKey(looper.path)] ?? 0;
    if (looper.loops.length > 0 && imported >= looper.loops.length) {
      setImportError(`${looper.title} is already fully downloaded.`);
      return;
    }
    setContextMenu(null);
    const jobId = crypto.randomUUID();
    activeJobId.current = jobId;
    setActiveLooper(looper.path);
    setProgress(null);
    setImportError(null);
    try {
      const url = new URL(looper.path, "https://tablist.net/").toString();
      const reports = await importTablistAndWait(url, jobId, looper.image || null);
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

  const downloadRandomLooper = async () => {
    if (!libraryReady || activeLooper !== null || randomLoading) return;
    setRandomLoading(true);
    setImportError(null);
    try {
      // Use the unfiltered catalogue total, not the current search or page.
      const catalog = await tablistSearch("", 0, 1);
      const available = catalog.estimatedTotalHits;
      if (available === 0) throw new Error("The Tablist catalogue is empty.");

      // Start on a random page and wrap through every catalogue page until
      // finding a valid looper that is not already fully downloaded.
      const pageCount = Math.ceil(available / PAGE_SIZE);
      const startPage = Math.floor(Math.random() * pageCount);
      for (let distance = 0; distance < pageCount; distance++) {
        const pageNumber = (startPage + distance) % pageCount;
        const page = await tablistSearch("", pageNumber * PAGE_SIZE);
        const candidates = page.hits.filter((looper) => {
          const imported = importCounts[routeKey(looper.path)] ?? 0;
          return looper.loops.length === 0 || imported < looper.loops.length;
        });
        if (candidates.length > 0) {
          const candidate = candidates[Math.floor(Math.random() * candidates.length)];
          await importLooper(candidate, true);
          return;
        }
      }
      throw new Error("Every valid looper in the Tablist catalogue is already downloaded.");
    } catch (reason) {
      setImportError(`Random looper: ${String(reason)}`);
    } finally {
      setRandomLoading(false);
    }
  };

  const cancel = () => {
    const jobId = activeJobId.current;
    if (jobId) cancelImport(jobId).catch((reason: unknown) => setImportError(String(reason)));
  };

  const copyLooperUrl = async (looper: TablistCatalogLooper) => {
    const url = new URL(looper.path, "https://tablist.net/").toString();
    try {
      await navigator.clipboard.writeText(url);
      setImportError("Looper URL copied to clipboard.");
    } catch (reason) {
      setImportError(`Could not copy looper URL: ${String(reason)}`);
    }
    setContextMenu(null);
  };

  const copyTrackNames = async (looper: TablistCatalogLooper) => {
    try {
      await navigator.clipboard.writeText(looper.loops.join("\n"));
      setImportError("Track names copied to clipboard.");
    } catch (reason) {
      setImportError(`Could not copy track names: ${String(reason)}`);
    }
    setContextMenu(null);
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
          disabled={activeLooper !== null || randomLoading}
          className="min-w-0 flex-1 rounded border border-border bg-elevated px-2.5 py-1 text-xs text-text placeholder:text-text-secondary/50 focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={() => void downloadRandomLooper()}
          disabled={!libraryReady || activeLooper !== null || randomLoading || loading}
          className="shrink-0 rounded bg-accent px-2.5 py-1 text-[10px] font-medium text-white hover:bg-accent/80 disabled:opacity-40"
        >
          {randomLoading ? "Buscando looper…" : "Descargar Random Looper"}
        </button>
        <span className="shrink-0 text-[10px] text-text-secondary">{loading ? "Loading…" : `${firstItem}–${lastItem} / ${total}`}</span>
        <button
          onClick={() => setPageNumber((page) => Math.max(0, page - 1))}
          disabled={loading || randomLoading || pageNumber === 0 || activeLooper !== null}
          aria-label="Previous catalog page"
          className="rounded bg-elevated px-2 py-1 text-xs text-text-secondary hover:text-text disabled:opacity-30"
        >
          ‹
        </button>
        <span className="text-[10px] tabular-nums text-text-secondary">{pageNumber + 1}/{pageCount}</span>
        <button
          onClick={() => setPageNumber((page) => page + 1)}
          disabled={loading || randomLoading || pageNumber + 1 >= pageCount || activeLooper !== null}
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

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,1.5fr)_4rem_6rem_5rem] gap-3 border-b border-border bg-elevated/50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
        <span>Looper</span>
        <span>Artists / tags</span>
        <span className="text-right">Loops</span>
        <span className="text-right">Added</span>
        <span className="text-right">Download</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && results.length === 0 && <p className="px-4 py-8 text-center text-xs text-text-secondary">Loading Tablist catalog…</p>}
        {!loading && !error && results.length === 0 && <p className="px-4 py-8 text-center text-xs text-text-secondary">No loopers found.</p>}
        {results.map((looper) => {
          const busy = activeLooper === looper.path;
          const imported = importCounts[routeKey(looper.path)] ?? 0;
          const downloaded = looper.loops.length > 0 && imported >= looper.loops.length;
          const partial = imported > 0 && !downloaded;
          return (
            <div
              key={looper.nid || looper.path}
              onDoubleClick={() => void importLooper(looper)}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({ looper, x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.target === event.currentTarget) void importLooper(looper);
              }}
              role="group"
              aria-label={`${looper.title}, ${looper.loops.length} loops`}
              title={`${looper.title} — double-click to download all tracks`}
              className="grid w-full grid-cols-[minmax(0,1fr)_minmax(9rem,1.5fr)_4rem_6rem_5rem] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left text-xs text-text transition-colors hover:bg-surface-hover"
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
              <span className="flex justify-end">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); void importLooper(looper); }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  disabled={!libraryReady || activeLooper !== null || randomLoading || downloaded}
                  aria-label={`Download all tracks from ${looper.title}`}
                  className={`rounded px-2 py-1 text-[10px] font-medium disabled:opacity-50 ${downloaded ? "bg-success/20 text-success" : partial ? "bg-warning/15 text-warning hover:bg-warning/25" : "bg-accent/15 text-accent hover:bg-accent/25"}`}
                >
                  {busy ? "Downloading…" : downloaded ? "Downloaded" : partial ? "Resume" : "Download"}
                </button>
              </span>
              {busy && <span className="col-span-5 text-[10px] text-accent">{progress?.stage ?? "Preparing Tablist import"}</span>}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between border-t border-border px-3 py-1.5 text-[10px] text-text-secondary">
        <span>{total} public looper{total === 1 ? "" : "s"}</span>
        <span>Double-click a looper to import all of its tracks</span>
      </div>
      {contextMenu && (
        <div
          className="fixed z-[90] min-w-[190px] rounded border border-border bg-elevated py-1 shadow-xl"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 130),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            disabled={!libraryReady || activeLooper !== null || randomLoading}
            onClick={() => void importLooper(contextMenu.looper)}
            className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover disabled:opacity-40"
          >
            Download all tracks
          </button>
          <button
            onClick={() => void copyLooperUrl(contextMenu.looper)}
            className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover"
          >
            Copy looper URL
          </button>
          <button
            onClick={() => void copyTrackNames(contextMenu.looper)}
            className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-hover"
          >
            Copy track names
          </button>
        </div>
      )}
    </aside>
  );
}
