import { useEffect, useRef, useState } from "react";
import { ownSubscription } from "../subscription";
import { cancelImport, importTablistAndWait, listenImportProgress, newImportJobId, tablistSearch, type ImportProgress, type TablistCatalogLooper } from "../tauri";
import { findRandomTablistLooper, isTablistLooperDownloaded } from "../tablistCatalog";

/** Own a catalog import and accept progress only from its active job. */
export function useTablistImport(
  libraryReady: boolean,
  importCounts: Record<string, number>,
  onImported: () => void,
  onImportStart: () => void,
  setCatalogError: (error: string | null) => void,
) {
  const [randomLoading, setRandomLoading] = useState(false);
  const [activeLooper, setActiveLooper] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const activeJobId = useRef<string | null>(null);

  useEffect(() => ownSubscription(listenImportProgress((next) => {
    if (next.job_id === activeJobId.current) setProgress(next);
  }), (reason: unknown) => setCatalogError(String(reason))), [setCatalogError]);

  const importLooper = async (looper: TablistCatalogLooper, fromRandom = false) => {
    if (!libraryReady || activeLooper !== null || (randomLoading && !fromRandom)) return;
    if (isTablistLooperDownloaded(looper, importCounts)) {
      setImportError(`${looper.title} is already fully downloaded.`);
      return;
    }
    onImportStart();
    const jobId = newImportJobId();
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
      if (failed.length > 0) setImportError(`${failed.length} track(s) failed: ${failed[0].error}`);
      else setImportError(`${added} added${existing ? `, ${existing} already in library` : ""}`);
      onImported();
    } catch (reason) {
      setImportError(String(reason));
      onImported();
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
      const candidate = await findRandomTablistLooper(tablistSearch, importCounts);
      await importLooper(candidate, true);
    } catch (reason) {
      setImportError(`Random looper: ${String(reason)}`);
    } finally { setRandomLoading(false); }
  };
  const cancel = () => {
    const jobId = activeJobId.current;
    if (jobId) cancelImport(jobId).catch((reason: unknown) => setImportError(String(reason)));
  };
  return { randomLoading, activeLooper, importError, setImportError, progress, importLooper, downloadRandomLooper, cancel };
}
