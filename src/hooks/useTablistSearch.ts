import { useEffect, useRef, useState } from "react";
import { libraryTablistImportCounts, tablistSearch, type TablistCatalogLooper, type TablistCatalogPage } from "../tauri";
import { TABLIST_PAGE_SIZE, tablistCountsByRoute } from "../tablistCatalog";

/** Own debounced catalog pages and the current library's download counts. */
export function useTablistSearch(libraryReady: boolean, refreshKey: number) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(0);
  const [results, setResults] = useState<TablistCatalogLooper[]>([]);
  const [total, setTotal] = useState(0);
  const [skippedPaths, setSkippedPaths] = useState(0);
  const [importCounts, setImportCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pages = useRef(new Map<string, { expires: number; page: TablistCatalogPage }>());

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPageNumber(0);
      setQuery(searchInput.trim());
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const key = JSON.stringify([query, pageNumber]);
    const apply = (page: TablistCatalogPage) => {
      setResults(page.hits);
      setTotal(page.estimatedTotalHits);
      setSkippedPaths(page.skippedInvalidPaths);
    };
    const cached = pages.current.get(key);
    if (cached && cached.expires > Date.now()) {
      pages.current.delete(key); pages.current.set(key, cached);
      apply(cached.page);
      setLoading(false);
      return;
    }
    setLoading(true);
    tablistSearch(query, pageNumber * TABLIST_PAGE_SIZE)
      .then((page) => {
        if (cancelled) return;
        pages.current.delete(key);
        pages.current.set(key, { expires: Date.now() + 30_000, page });
        if (pages.current.size > 8) pages.current.delete(pages.current.keys().next().value!);
        apply(page);
      })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, pageNumber]);

  useEffect(() => {
    if (!libraryReady) {
      setImportCounts({});
      return;
    }
    let cancelled = false;
    libraryTablistImportCounts()
      .then((counts) => { if (!cancelled) setImportCounts(tablistCountsByRoute(counts)); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [libraryReady, refreshKey]);

  return { searchInput, setSearchInput, pageNumber, setPageNumber, results, total, skippedPaths, importCounts, loading, error, setError };
}
