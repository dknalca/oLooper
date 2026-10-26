import { useEffect, useRef, useState } from "react";
import {
  bpmReanalysisStatus, cancelBpmReanalysis, listenBpmReanalysisProgress,
  newImportJobId, reanalyzeBpm, type BpmReanalysisProgress, type Track,
} from "../tauri";
import type { BpmReanalysisRequest } from "../bpmReanalysis";

interface Props {
  libraryRoot: string | null;
  libraryGeneration: number;
  onUpdated: (track: Track, owner: { libraryRoot: string; libraryGeneration: number }) => void;
  onFinished: () => void;
}

export default function BpmReanalysisPanel({ libraryRoot, libraryGeneration, onUpdated, onFinished }: Props) {
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
      // Root changes are also cancelled by the backend. A pending admission
      // repeats cancellation after its command resolves, avoiding an early race.
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
  if (!progress && !pending && !error) return null;
  const running = pending || progress?.state === "running";
  const report = progress?.report;
  return (
    <section aria-label="BPM reanalysis" className="shrink-0 border-b border-border bg-elevated px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <span role="status" className="min-w-0 flex-1 truncate">
          {running ? "Reanalyzing BPM" : progress?.state === "cancelled" ? "BPM analysis cancelled" : progress?.state === "failed" || error ? "BPM analysis failed" : "BPM analysis completed"}
          {` — ${label}`}{report ? ` · ${report.processed} / ${report.total}` : ""}
        </span>
        {running
          ? <button onClick={cancel} disabled={cancelling} className="toolbar-button">{cancelling ? "Cancelling…" : "Cancel analysis"}</button>
          : <button onClick={() => { setProgress(null); setError(null); }} className="toolbar-button" aria-label="Dismiss BPM analysis">Dismiss</button>}
      </div>
      {report && <>
        <progress aria-label="BPM analysis progress" value={report.processed} max={Math.max(1, report.total)} className="mt-1 h-1 w-full" />
        <p className="mt-1 text-text-secondary">Updated: {report.updated} · Protected: {report.protected} · Changed meanwhile: {report.changed_since_start} · No estimate: {report.no_estimate} · Failed: {report.failed} · Remaining: {report.unprocessed}</p>
      </>}
      {running && <p className="mt-1 text-text-secondary">Automatic BPMs are updated. Confirmed BPMs and file tags are preserved.</p>}
      {(error || progress?.error) && <p role="alert" className="mt-1 text-danger">{error ?? progress?.error}</p>}
      {!!report?.errors.length && <details className="mt-1 text-danger"><summary>Track errors (first 20)</summary><ul>{report.errors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
    </section>
  );
}
