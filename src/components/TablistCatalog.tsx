import { useEffect, useState } from "react";
import { useTablistSearch } from "../hooks/useTablistSearch";
import { useTablistImport } from "../hooks/useTablistImport";
import type { TablistCatalogLooper } from "../tauri";
import type { LibraryView } from "./LibraryViewTabs";
import TablistLooperRow from "./TablistLooperRow";
import TablistCatalogHeader from "./TablistCatalogHeader";

interface Props {
  libraryReady: boolean;
  refreshKey: number;
  onImported: () => void;
  onLibraryViewChange: (view: LibraryView) => void;
}

interface CatalogContextMenu {
  looper: TablistCatalogLooper;
  x: number;
  y: number;
}

export default function TablistCatalog({ libraryReady, refreshKey, onImported, onLibraryViewChange }: Props) {
  const { searchInput, setSearchInput, pageNumber, setPageNumber, results, total, skippedPaths, importCounts, loading, error, setError } = useTablistSearch(libraryReady, refreshKey);
  const [contextMenu, setContextMenu] = useState<CatalogContextMenu | null>(null);
  const { randomLoading, activeLooper, importError, setImportError, progress, importLooper, downloadRandomLooper, cancel } = useTablistImport(
    libraryReady, importCounts, onImported, () => setContextMenu(null), setError,
  );

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

  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-surface">
      <TablistCatalogHeader libraryReady={libraryReady} search={searchInput} pageNumber={pageNumber}
        resultCount={results.length} total={total} loading={loading} randomLoading={randomLoading} activeLooper={activeLooper}
        onLibraryViewChange={onLibraryViewChange} onSearch={setSearchInput} onRandom={() => void downloadRandomLooper()}
        onPrevious={() => setPageNumber((page) => Math.max(0, page - 1))} onNext={() => setPageNumber((page) => page + 1)} />

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
        {results.map((looper) => <TablistLooperRow key={looper.nid || looper.path} looper={looper} counts={importCounts}
          libraryReady={libraryReady} activeLooper={activeLooper} randomLoading={randomLoading} progress={progress}
          onImport={(item) => void importLooper(item)} onContextMenu={(item, x, y) => setContextMenu({ looper: item, x, y })} />)}
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
