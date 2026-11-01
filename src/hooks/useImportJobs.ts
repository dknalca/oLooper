import { useEffect, useRef, useState } from "react";
import { ownSubscription } from "../subscription";
import { cancelImport, listenImportProgress, newImportJobId, type ImportProgress } from "../tauri";

export interface ImportFileState {
  path: string;
  stage: string;
  done: boolean;
  error: string | null;
}

/** Own the active job identity, progress subscription and queue cancellation. */
export function useImportJobs(setError: (error: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [files, setFiles] = useState<ImportFileState[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const cancelQueue = useRef(false);
  const busyRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);

  const setImportBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  const runOwnedJob = async <T,>(path: string, run: (jobId: string) => Promise<T>): Promise<T> => {
    const jobId = newImportJobId();
    activeJobIdRef.current = jobId;
    activePathRef.current = path;
    setFiles((current) => current.map((file) => file.path === path
      ? { ...file, stage: "Preparing", done: false, error: null }
      : file));
    try {
      return await run(jobId);
    } finally {
      if (activeJobIdRef.current === jobId) {
        activeJobIdRef.current = null;
        activePathRef.current = null;
      }
    }
  };
  const beginImport = (paths: string[]) => {
    cancelQueue.current = false;
    setFiles(paths.map((path) => ({ path, stage: "Queued", done: false, error: null })));
    setStartedAt(Date.now());
    setElapsed(0);
    setProgress({
      job_id: "pending", stage: "preparing import", current: 0, total: 0,
      detail: `${paths.length} file(s) ready`, done: false, error: null, report: null, custom_report: null,
    });
  };
  const requestCancel = () => {
    cancelQueue.current = true;
    const activeJobId = activeJobIdRef.current;
    if (activeJobId) cancelImport(activeJobId).catch((error) => setError(String(error)));
    setFiles((current) => current.map((file) => file.stage === "Queued" ? { ...file, stage: "Cancelled", done: true } : file));
  };
  const finishProgress = (error: string | null = null) => {
    setProgress((current) => current && { ...current, stage: error ? "failed" : "complete", done: true, error });
  };

  useEffect(() => {
    return ownSubscription(listenImportProgress((next) => {
      if (activeJobIdRef.current !== next.job_id) return;
      setProgress(next);
      const activePath = activePathRef.current;
      setFiles((current) => current.map((file) => file.path === next.detail || file.path === activePath
        ? { ...file, stage: next.stage, done: next.done, error: next.error }
        : file));
    }), (error) => setError(`Import progress unavailable: ${String(error)}`));
  }, [setError]);

  useEffect(() => {
    if (startedAt === null || progress?.done) return;
    const interval = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [progress?.done, startedAt]);

  return { busy, busyRef, setImportBusy, progress, setProgress, files, elapsed, cancelQueue, runOwnedJob, beginImport, requestCancel, finishProgress };
}
