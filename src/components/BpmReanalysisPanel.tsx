import type { Track } from "../tauri";
import { useBpmReanalysis } from "../hooks/useBpmReanalysis";

interface Props {
  libraryRoot: string | null;
  libraryGeneration: number;
  onUpdated: (track: Track, owner: { libraryRoot: string; libraryGeneration: number }) => void;
  onFinished: () => void;
}

export default function BpmReanalysisPanel({ libraryRoot, libraryGeneration, onUpdated, onFinished }: Props) {
  const { progress, pending, cancelling, label, error, cancel, dismiss } = useBpmReanalysis(libraryRoot, libraryGeneration, onUpdated, onFinished);
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
          : <button onClick={dismiss} className="toolbar-button" aria-label="Dismiss BPM analysis">Dismiss</button>}
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
