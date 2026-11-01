import { useEffect, useRef, useState } from "react";
import {
  bpmReanalysisStatus, cancelBpmReanalysis, listenBpmReanalysisProgress,
  newImportJobId, reanalyzeBpm, type BpmReanalysisProgress, type Track,
} from "../tauri";
import type { BpmReanalysisRequest } from "../bpmReanalysis";

/** Own admission, progress and cancellation for one library generation. */
export function useBpmReanalysis(
  libraryRoot: string | null,
  libraryGeneration: number,
  onUpdated: (track: Track, owner: { libraryRoot: string; libraryGeneration: number }) => void,
  onFinished: () => void,
) {
  const [progress, setProgress] = useState<BpmReanalysisProgress | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [label, setLabel] = useState("Library");
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onUpdated, onFinished });
  callbacks.current = { onUpdated, onFinished };
  const owner = useRef({ libraryRoot, libraryGeneration });
  owner.current = { libraryRoot, libraryGeneration };
  const job = useRef<string | null>(null);
  const cancelRequested = useRef(false);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const finished = new Set<string>();
    job.current = null;
    cancelRequested.current = false;
    setProgress(null); setPending(false); setCancelling(false); setError(null);
    const apply = (value: BpmReanalysisProgress) => {
      if (disposed || owner.current.libraryRoot !== libraryRoot || owner.current.libraryGeneration !== libraryGeneration || value.library_root !== libraryRoot || (job.current && value.job_id !== job.current)) return;
      job.current = value.job_id;
      setProgress(value);
      setPending(false);
      if (value.updated_track) callbacks.current.onUpdated(value.updated_track, { libraryRoot: value.library_root, libraryGeneration });
      if (value.state !== "running" && !finished.has(value.job_id)) {
        finished.add(value.job_id);
        setCancelling(false);
        callbacks.current.onFinished();
      }
    };
    // Admission waits for this subscription, including very fast completions.
    const ready = listenBpmReanalysisProgress(apply).then((release) => {
      off = release;
      if (disposed) release();
    });
    void ready.then(async () => {
      if (!disposed && job.current === null) {
        const value = await bpmReanalysisStatus();
        if (!disposed && job.current === null && value?.library_root === libraryRoot) apply(value);
      }
    }).catch((cause) => { if (!disposed) setError(String(cause)); });
    const request = (event: Event) => {
      if (!libraryRoot || disposed) return;
      const detail = (event as CustomEvent<BpmReanalysisRequest>).detail;
      if (!detail || (job.current && !finished.has(job.current))) return;
      const id = newImportJobId();
      job.current = id;
      cancelRequested.current = false;
      setLabel(detail.label); setProgress(null); setPending(true); setError(null); setCancelling(false);
      void (async () => {
        try {
          await ready;
          if (disposed) return;
          await reanalyzeBpm(detail.scope, id);
          if (disposed || cancelRequested.current) await cancelBpmReanalysis(id);
        } catch (cause) {
          if (!disposed && job.current === id) {
            finished.add(id); setPending(false); setCancelling(false); setError(String(cause));
          }
        }
      })();
    };
    window.addEventListener("olooper:reanalyze-bpm", request);
    return () => {
      disposed = true;
      off?.();
      window.removeEventListener("olooper:reanalyze-bpm", request);
      // A pending admission repeats cancellation after its command resolves.
      if (job.current && !finished.has(job.current)) void cancelBpmReanalysis(job.current).catch(() => {});
    };
  }, [libraryRoot, libraryGeneration]);

  const cancel = () => {
    cancelRequested.current = true;
    setCancelling(true);
    if (job.current) void cancelBpmReanalysis(job.current).catch((cause) => {
      setCancelling(false); setError(String(cause));
    });
  };
  const dismiss = () => { setProgress(null); setError(null); };
  return { progress, pending, cancelling, label, error, cancel, dismiss };
}
