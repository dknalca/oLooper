import type { TablistCatalogLooper, TablistCatalogPage, TablistImportCount } from "./tauri";

export const TABLIST_PAGE_SIZE = 24;

/** Normalize catalog paths and known-host URLs for matching imported counts. */
export function tablistRouteKey(pathOrUrl: string): string {
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

export function tablistCountsByRoute(counts: TablistImportCount[]): Record<string, number> {
  const byRoute: Record<string, number> = {};
  for (const item of counts) {
    const key = tablistRouteKey(item.source_path);
    byRoute[key] = (byRoute[key] ?? 0) + item.tracks;
  }
  return byRoute;
}

export function isTablistLooperDownloaded(looper: TablistCatalogLooper, counts: Record<string, number>): boolean {
  return looper.loops.length > 0 && (counts[tablistRouteKey(looper.path)] ?? 0) >= looper.loops.length;
}

/** Search every page from a random starting point until an eligible looper is found. */
export async function findRandomTablistLooper(
  search: (query: string, offset: number, limit?: number) => Promise<TablistCatalogPage>,
  counts: Record<string, number>,
  random: () => number = Math.random,
): Promise<TablistCatalogLooper> {
  const catalog = await search("", 0, 1);
  const available = catalog.estimatedTotalHits;
  if (available === 0) throw new Error("The Tablist catalogue is empty.");
  const pageCount = Math.ceil(available / TABLIST_PAGE_SIZE);
  const startPage = Math.floor(random() * pageCount);
  for (let distance = 0; distance < pageCount; distance++) {
    const pageNumber = (startPage + distance) % pageCount;
    const page = await search("", pageNumber * TABLIST_PAGE_SIZE);
    const candidates = page.hits.filter((looper) => !isTablistLooperDownloaded(looper, counts));
    if (candidates.length > 0) return candidates[Math.floor(random() * candidates.length)];
  }
  throw new Error("Every valid looper in the Tablist catalogue is already downloaded.");
}
