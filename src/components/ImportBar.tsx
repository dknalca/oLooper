import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  importCustomAndWait,
  cancelImport,
  importExeAndWait,
  importSwfAndWait,
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
  const cancelQueue = useRef(false);

  const startProgress = (detail: string) => setProgress({
    job_id: "pending",
    stage: "preparing import",
    current: 0,
    total: 0,
    detail,
    done: false,
    error: null,
    report: null,
    custom_report: null,
  });

  const beginImport = (paths: string[]) => {
    cancelQueue.current = false;
    setFiles(paths.map((path) => ({ path, stage: "Queued", done: false, error: null })));
    setStartedAt(Date.now());
    setElapsed(0);
    startProgress(`${paths.length} file(s) ready`);
  };

  const requestCancel = () => {
    cancelQueue.current = true;
    if (progress?.job_id && progress.job_id !== "pending") cancelImport(progress.job_id).catch((e) => setError(String(e)));
    setFiles((current) => current.map((file) => file.stage === "Queued" ? { ...file, stage: "Cancelled", done: true } : file));
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
          (async () => {
            let totalAdded = 0;
            let totalExisting = 0;
            let totalFailed = 0;
            let firstError: string | null = null;
            for (const path of paths) {
              if (cancelQueue.current) break;
              setFiles((current) => current.map((file) => file.path === path ? { ...file, stage: "Preparing", done: false } : file));
              try {
                const kind = importKindForPath(path);
                if (kind === "swf") {
                  const r = await importSwfAndWait(path);
                  totalAdded += r.added;
                  totalExisting += r.already_there;
                } else if (kind === "exe") {
                  const r = await importExeAndWait(path);
                  totalAdded += r.added;
                  totalExisting += r.already_there;
                } else {
                  const rs = await importCustomAndWait([path]);
                  totalAdded += rs.filter((r) => r.added).length;
                  totalExisting += rs.filter((r) => r.error === "already in library").length;
                  const bad = rs.filter((r) => !r.added && r.error !== "already in library");
                  if (bad.length > 0) { totalFailed++; firstError ??= bad[0].error ?? "import failed"; }
                }
              } catch (reason) {
                totalFailed++;
                firstError ??= String(reason);
              }
            }
            if (totalFailed > 0) {
              setError(`${totalFailed} file(s) failed: ${firstError}`);
              finishProgress(firstError);
            } else {
              finishProgress();
            }
            if (totalExisting > 0) showNotice(`${totalExisting} existing track${totalExisting === 1 ? "" : "s"} already in library`);
            if (totalAdded > 0) {
              setDragCount(totalAdded);
              setTimeout(() => setDragCount(null), 3000);
            }
            onImported();
            setBusy(false);
          })();
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
      const rs = await importCustomAndWait(files);
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

      {notice && <div className="fixed right-4 top-14 z-[80] rounded border border-success/40 bg-surface px-4 py-3 text-xs text-success shadow-xl" role="status">{notice}</div>}

      <div className="flex items-center gap-2 px-4 py-2 bg-surface border-t border-border">
        <BrowseBtn
          onClick={() => browseAndImport(importSwfAndWait, [
            { name: "Flash files", extensions: ["swf"] },
          ])}
          disabled={busy}
          label="SWF"
        />
        <BrowseBtn
          onClick={() => browseAndImport(importExeAndWait, [
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

        {progress && !progress.done && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-accent animate-pulse">{progress.stage}</span>
            {progress.total > 0 && (
              <span className="text-[10px] text-text-secondary">{progress.current}/{progress.total}</span>
            )}
            {busy && (
              <button onClick={requestCancel} className="text-[10px] text-danger hover:text-danger/80 transition-colors">Cancel</button>
            )}
          </div>
        )}

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

      {progress && files.length > 0 && (
        <div className="border-t border-border/50 bg-surface/80 px-4 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-secondary">Importing</span>
              {progress.total > 0 && (
                <div className="w-24 h-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }} />
                </div>
              )}
              {progress.total > 0 && (
                <span className="text-[10px] text-text-secondary">{Math.round((progress.current / progress.total) * 100)}%</span>
              )}
              <span className="font-mono text-[10px] text-text-secondary">{elapsedLabel(elapsed)}</span>
            </div>
            <div className="flex items-center gap-2">
              {progress.error && (
                <span className="text-[10px] text-danger">{progress.error}</span>
              )}
              {progress.done && (
                <button onClick={() => setProgress(null)} className="text-[10px] text-text-secondary hover:text-text transition-colors">Dismiss</button>
              )}
            </div>
          </div>
          <div className="max-h-24 overflow-y-auto rounded border border-border/30">
            {files.map((file) => (
              <div key={file.path} className="flex items-center gap-2 border-b border-border/20 px-2 py-1 text-[10px] last:border-b-0">
                <span className={`h-1 w-1 rounded-full shrink-0 ${file.error ? "bg-danger" : file.done ? "bg-success" : "bg-accent"}`} />
                <span className="min-w-0 flex-1 truncate text-text" title={file.path}>{fileName(file.path)}</span>
                <span className="shrink-0 text-text-secondary">{file.error ?? file.stage}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
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
