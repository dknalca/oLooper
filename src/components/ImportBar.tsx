import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  importCustom,
  importExe,
  importSwf,
  listenImportProgress,
  type ImportProgress,
  pickFiles,
  type ImportReport,
} from "../tauri";
import { elapsedLabel, fileName, importKindForPath } from "../importFlow";

interface Props {
  onImported: () => void;
}

interface ImportFileState {
  path: string;
  stage: string;
  done: boolean;
  error: string | null;
}

export default function ImportBar({ onImported }: Props) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [files, setFiles] = useState<ImportFileState[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const startProgress = (detail: string) => setProgress({
    job_id: "pending",
    stage: "preparing import",
    current: 0,
    total: 0,
    detail,
    done: false,
    error: null,
  });

  const beginImport = (paths: string[]) => {
    setFiles(paths.map((path) => ({ path, stage: "Queued", done: false, error: null })));
    setStartedAt(Date.now());
    setElapsed(0);
    startProgress(`${paths.length} file(s) ready`);
  };

  const finishProgress = (error: string | null = null) => {
    setProgress((current) => current && { ...current, stage: error ? "failed" : "complete", done: true, error });
  };

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    listenImportProgress((next) => {
      setProgress(next);
      setFiles((current) => current.map((file) => fileName(file.path) === fileName(next.detail)
        ? { ...file, stage: next.stage, done: next.done, error: next.error }
        : file));
    }).then((unlisten) => { off = unlisten; }).catch((e) => setError(`Import progress unavailable: ${String(e)}`));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (startedAt === null || progress?.done) return;
    const interval = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [progress?.done, startedAt]);

  // Webview drag&drop
  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = event.payload.paths;
          if (paths.length === 0) return;
          setBusy(true);
          beginImport(paths);
          setError(null);
          setReport(null);
          Promise.allSettled(paths.map(async (path) => {
            const kind = importKindForPath(path);
            if (kind === "swf") return importSwf(path);
            if (kind === "exe") return importExe(path);
            return importCustom([path]);
          }))
            .then((results) => {
              const reports = results
                .filter((result): result is PromiseFulfilledResult<ImportReport | Awaited<ReturnType<typeof importCustom>>> => result.status === "fulfilled")
                .map((result) => result.value);
              const failed = results.filter((result) => result.status === "rejected");
              const added = reports.reduce((sum, result) => {
                if (Array.isArray(result)) return sum + result.filter((entry) => entry.added).length;
                return sum + result.added;
              }, 0);
              if (failed.length > 0) {
                setError(`${failed.length} file(s) failed: ${String(failed[0].reason)}`);
                finishProgress(String(failed[0].reason));
              } else {
                finishProgress();
              }
              const existing = reports.reduce((sum, result) => sum + (Array.isArray(result)
                ? result.filter((entry) => entry.error === "already in library").length
                : result.already_there), 0);
              if (existing > 0) showNotice(`${existing} existing track${existing === 1 ? "" : "s"} already in library`);
              if (added > 0) {
                setDragCount(added);
                setTimeout(() => setDragCount(null), 3000);
              }
              onImported();
            })
            .finally(() => setBusy(false));
        } else {
          setDragging(false);
        }
      })
      .then((f) => { off = f; })
      .catch((e) => setError(`Drag and drop unavailable: ${String(e)}`));
    return () => off?.();
  }, [onImported]);

  const browseAndImport = async (
    importFn: (p: string) => Promise<ImportReport>,
    filters: { name: string; extensions: string[] }[],
  ) => {
    const files = await pickFiles(filters);
    if (files.length === 0) return;
    setBusy(true);
    beginImport(files);
    setError(null);
    setReport(null);
    // Import each file sequentially, accumulate results
    let totalAdded = 0;
    let failedSounds = 0;
    const failures: string[] = [];
    let lastReport: ImportReport | null = null;
    for (const f of files) {
      try {
        const r = await importFn(f);
        lastReport = r;
        totalAdded += r.added;
        failedSounds += r.failed.length;
      } catch (e) {
        failures.push(`${f}: ${String(e)}`);
      }
    }
    if (lastReport) setReport(lastReport);
    if (failures.length > 0 || failedSounds > 0) {
      const summary = [
        failures.length > 0 ? `${failures.length} file(s) failed` : "",
        failedSounds > 0 ? `${failedSounds} embedded sound(s) skipped` : "",
      ].filter(Boolean).join("; ");
      setError(summary);
    }
    if (totalAdded > 0) {
      setDragCount(totalAdded);
      setTimeout(() => setDragCount(null), 3000);
    }
    const existing = lastReport?.already_there ?? 0;
    if (existing > 0) showNotice(`${existing} existing track${existing === 1 ? "" : "s"} already in library`);
    finishProgress(failures.length > 0 ? failures[0] : null);
    setBusy(false);
    onImported();
  };

  const browseAndImportCustom = async () => {
    const files = await pickFiles([
      { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "aac", "m4a"] },
    ]);
    if (files.length === 0) return;
    setBusy(true);
    beginImport(files);
    setError(null);
    setReport(null);
    try {
      const rs = await importCustom(files);
      const failed = rs.filter((r) => !r.added && r.error !== "already in library");
      const added = rs.filter((r) => r.added).length;
      const existing = rs.filter((r) => r.error === "already in library").length;
      if (failed.length > 0) {
        setError(`${failed.length} file(s) failed: ${failed[0].error}`);
      } else if (added > 0) {
        setDragCount(added);
        setTimeout(() => setDragCount(null), 3000);
      }
      if (existing > 0) showNotice(`${existing} existing track${existing === 1 ? "" : "s"} already in library`);
      finishProgress(failed.length > 0 ? failed[0].error : null);
    } catch (e) {
      setError(String(e));
      finishProgress(String(e));
    }
    setBusy(false);
    onImported();
  };

  return (
    <>
      {/* Full-window drag overlay */}
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent pointer-events-none">
          <div className="bg-surface/90 backdrop-blur-sm rounded-lg px-6 py-4 border border-accent/30 text-sm text-accent font-medium">
            Drop files to import
          </div>
        </div>
      )}

      {progress && <ImportProgressModal progress={progress} files={files} elapsed={elapsed} onClose={() => setProgress(null)} />}
      {notice && <div className="fixed right-4 top-14 z-[80] rounded border border-success/40 bg-surface px-4 py-3 text-xs text-success shadow-xl" role="status">{notice}</div>}

      <div className="flex items-center gap-2 px-4 py-2 bg-surface border-t border-border">
        <BrowseBtn
          onClick={() => browseAndImport(importSwf, [
            { name: "Flash files", extensions: ["swf"] },
          ])}
          disabled={busy}
          label="SWF"
        />
        <BrowseBtn
          onClick={() => browseAndImport(importExe, [
            { name: "Projector files", extensions: ["exe"] },
          ])}
          disabled={busy}
          label="EXE"
        />
        <BrowseBtn
          onClick={browseAndImportCustom}
          disabled={busy}
          label="Audio"
        />

        <div className="flex-1" />

        {dragCount !== null && (
          <span className="text-[10px] text-success">+{dragCount} imported</span>
        )}
        {report && report.added > 0 && (
          <span className="text-[10px] text-text-secondary">
            {report.added > 0 && <span className="text-success">+{report.added}</span>}
          </span>
        )}
        {error && (
          <span
            className={`text-[10px] ${error === "already in library" ? "text-text-secondary" : "text-danger"}`}
            role="alert"
          >
            {error}
          </span>
        )}
      </div>
    </>
  );
}

function ImportProgressModal({
  progress,
  files,
  elapsed,
  onClose,
}: {
  progress: ImportProgress;
  files: ImportFileState[];
  elapsed: number;
  onClose: () => void;
}) {
  const progressText = progress.total > 0 ? `${progress.current} / ${progress.total}` : "";
  const fraction = progress.total > 0 ? Math.min(1, progress.current / progress.total) : 0;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-app/80 backdrop-blur-sm" role="status">
      <div className="w-[28rem] rounded-lg border border-border bg-surface p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs uppercase tracking-wider text-text-secondary">Importing looper</p>
          <span className="font-mono text-[10px] text-text-secondary">{elapsedLabel(elapsed)}</span>
        </div>
        <p className={`mt-2 text-base font-medium ${progress.error ? "text-danger" : "text-text"}`}>
          {progress.stage}
        </p>
        <p className="mt-1 truncate text-xs text-text-secondary" title={progress.detail}>
          {progress.detail}
        </p>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-border">
          <svg viewBox="0 0 100 2" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
            <line
              x1="0"
              y1="1"
              x2={(progress.done ? 1 : fraction) * 100}
              y2="1"
              className="stroke-accent"
              strokeWidth="2"
            />
          </svg>
        </div>
        <p className="mt-2 text-right text-[10px] text-text-secondary">{progress.error ?? progressText}</p>
        <div className="mt-4 max-h-36 overflow-y-auto rounded border border-border/70">
          {files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs last:border-b-0">
              <span className={`h-1.5 w-1.5 rounded-full ${file.error ? "bg-danger" : file.done ? "bg-success" : "bg-accent"}`} />
              <span className="min-w-0 flex-1 truncate text-text" title={file.path}>{fileName(file.path)}</span>
              <span className="shrink-0 text-[10px] text-text-secondary">{file.error ?? file.stage}</span>
            </div>
          ))}
        </div>
        {progress.done && (
          <div className="mt-5 flex justify-end">
            <button onClick={onClose} className="rounded bg-border px-3 py-1.5 text-xs text-text hover:bg-surface-hover">Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

function BrowseBtn({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 bg-border/50 hover:bg-border disabled:opacity-30 text-text-secondary hover:text-text text-[10px] font-medium px-2.5 py-1 rounded transition-colors"
    >
      <svg viewBox="0 0 16 16" className="w-3 h-3 fill-current shrink-0">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
      </svg>
      {label}
    </button>
  );
}
