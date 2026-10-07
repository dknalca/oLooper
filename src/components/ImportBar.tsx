import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  importCustomAndWait,
  cancelImport,
  importExeAndWait,
  newImportJobId,
  importSwfAndWait,
  listenImportProgress,
  type AppMenuCommand,
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
  const [modePrompt, setModePrompt] = useState<{ resolve: (mode: "extract" | "embedded" | null) => void } | null>(null);
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
  const busyRef = useRef(false);
  const activeJobIdRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);
  const internalTrackDrag = useRef(false);
  const modeDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modePrompt) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    modeDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previousFocus?.focus();
  }, [modePrompt]);

  const chooseContainerMode = (paths: string[]): Promise<"extract" | "embedded" | null> => {
    if (!paths.some((path) => ["swf", "exe"].includes(importKindForPath(path)))) return Promise.resolve("extract");
    return new Promise((resolve) => setModePrompt({ resolve }));
  };

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
    const activeJobId = activeJobIdRef.current;
    if (activeJobId) cancelImport(activeJobId).catch((e) => setError(String(e)));
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
      if (activeJobIdRef.current !== next.job_id) return;
      setProgress(next);
      const activePath = activePathRef.current;
      setFiles((current) => current.map((file) => file.path === next.detail || file.path === activePath
        ? { ...file, stage: next.stage, done: next.done, error: next.error }
        : file));
    }).then((unlisten) => { off = unlisten; }).catch((e) => setError(`Import progress unavailable: ${String(e)}`));
    return () => off?.();
  }, []);

  useEffect(() => {
    let releaseTimer = 0;
    const trackDragStarted = () => {
      window.clearTimeout(releaseTimer);
      internalTrackDrag.current = true;
      setDragging(false);
    };
    const trackDragEnded = () => {
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => { internalTrackDrag.current = false; }, 500);
    };
    window.addEventListener("olooper:library-internal-drag-start", trackDragStarted);
    window.addEventListener("olooper:library-internal-drag-end", trackDragEnded);
    return () => {
      window.clearTimeout(releaseTimer);
      window.removeEventListener("olooper:library-internal-drag-start", trackDragStarted);
      window.removeEventListener("olooper:library-internal-drag-end", trackDragEnded);
    };
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
        if (internalTrackDrag.current) return;
        if (event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          const paths = event.payload.paths;
          if (paths.length === 0) return;
          if (busyRef.current) {
            setError("An import is already in progress.");
            return;
          }
          setImportBusy(true);
          setError(null);
          setReport(null);
          (async () => {
            const containerMode = await chooseContainerMode(paths);
            if (!containerMode) { setImportBusy(false); return; }
            beginImport(paths);
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
                  const r = await runOwnedJob(path, (jobId) => importSwfAndWait(path, jobId, containerMode === "extract"));
                  totalAdded += r.added;
                  totalExisting += r.already_there;
                } else if (kind === "exe") {
                  const r = await runOwnedJob(path, (jobId) => importExeAndWait(path, jobId, containerMode === "extract"));
                  totalAdded += r.added;
                  totalExisting += r.already_there;
                } else {
                  const rs = await runOwnedJob(path, (jobId) => importCustomAndWait([path], jobId));
                  totalAdded += rs.filter((r) => r.added).length;
                  totalExisting += rs.filter((r) => r.error === "already in library").length;
                  const bad = rs.filter((r) => !r.added && r.error !== "already in library");
                  if (bad.length > 0) { totalFailed++; firstError ??= bad[0].error ?? "import failed"; }
                }
              } catch (reason) {
                if (!cancelQueue.current) {
                  totalFailed++;
                  firstError ??= String(reason);
                }
              }
            }
            if (totalFailed > 0) {
              setError(`${totalFailed} file(s) failed: ${firstError}`);
              finishProgress(firstError);
            } else {
              finishProgress(cancelQueue.current ? "import cancelled" : null);
            }
            if (totalExisting > 0) showNotice(`${totalExisting} existing track${totalExisting === 1 ? "" : "s"} already in library`);
            if (totalAdded > 0) {
              setDragCount(totalAdded);
              setTimeout(() => setDragCount(null), 3000);
            }
            onImported();
            setImportBusy(false);
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
    importFn: (p: string, jobId: string, mode: "extract" | "embedded") => Promise<ImportReport>,
    filters: { name: string; extensions: string[] }[],
  ) => {
    if (busyRef.current) return;
    setImportBusy(true);
    let files: string[];
    try {
      files = await pickFiles(filters);
    } catch (cause) {
      setError(String(cause));
      setImportBusy(false);
      return;
    }
    if (files.length === 0) {
      setImportBusy(false);
      return;
    }
    const containerMode = await chooseContainerMode(files);
    if (!containerMode) { setImportBusy(false); return; }
    beginImport(files);
    setError(null);
    setReport(null);
    // Import each file sequentially, accumulate results
    let totalAdded = 0;
    let failedSounds = 0;
    const failures: string[] = [];
    let lastReport: ImportReport | null = null;
    for (const f of files) {
      if (cancelQueue.current) break;
      try {
        const r = await runOwnedJob(f, (jobId) => importFn(f, jobId, containerMode));
        lastReport = r;
        totalAdded += r.added;
        failedSounds += r.failed.length;
      } catch (e) {
        if (!cancelQueue.current) failures.push(`${f}: ${String(e)}`);
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
    finishProgress(failures.length > 0 ? failures[0] : cancelQueue.current ? "import cancelled" : null);
    setImportBusy(false);
    onImported();
  };

  const browseAndImportCustom = async () => {
    if (busyRef.current) return;
    setImportBusy(true);
    let files: string[];
    try {
      files = await pickFiles([
        { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "aac", "m4a"] },
      ]);
    } catch (cause) {
      setError(String(cause));
      setImportBusy(false);
      return;
    }
    if (files.length === 0) {
      setImportBusy(false);
      return;
    }
    beginImport(files);
    setError(null);
    setReport(null);
    try {
      const rs = await runOwnedJob(files[0], (jobId) => importCustomAndWait(files, jobId));
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
    setImportBusy(false);
    onImported();
  };

  const importFromMenu = async (command: AppMenuCommand) => {
    if (busyRef.current) return;
    if (command === "open-swf") {
      await browseAndImport((path, jobId, mode) => importSwfAndWait(path, jobId, mode === "extract"), [{ name: "Flash files", extensions: ["swf"] }]);
      return;
    }
    if (command === "open-exe") {
      await browseAndImport((path, jobId, mode) => importExeAndWait(path, jobId, mode === "extract"), [{ name: "Projector files", extensions: ["exe"] }]);
      return;
    }
    if (command === "import-audio") {
      await browseAndImportCustom();
      return;
    }
    if (command !== "import-files") return;

    setImportBusy(true);
    let paths: string[];
    try {
      paths = await pickFiles([
        { name: "Flash and projector files", extensions: ["swf", "exe"] },
        { name: "Audio", extensions: ["mp3", "wav", "flac", "ogg", "aac", "m4a"] },
      ]);
    } catch (cause) {
      setError(String(cause));
      setImportBusy(false);
      return;
    }
    if (paths.length === 0) {
      setImportBusy(false);
      return;
    }
    const containerMode = await chooseContainerMode(paths);
    if (!containerMode) { setImportBusy(false); return; }
    beginImport(paths);
    setError(null);
    setReport(null);
    let added = 0;
    let existing = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const path of paths) {
      if (cancelQueue.current) break;
      try {
        const kind = importKindForPath(path);
        if (kind === "swf") {
          const report = await runOwnedJob(path, (jobId) => importSwfAndWait(path, jobId, containerMode === "extract"));
          added += report.added;
          existing += report.already_there;
        } else if (kind === "exe") {
          const report = await runOwnedJob(path, (jobId) => importExeAndWait(path, jobId, containerMode === "extract"));
          added += report.added;
          existing += report.already_there;
        } else {
          const reports = await runOwnedJob(path, (jobId) => importCustomAndWait([path], jobId));
          added += reports.filter((report) => report.added).length;
          existing += reports.filter((report) => report.error === "already in library").length;
          const rejected = reports.find((report) => !report.added && report.error !== "already in library");
          if (rejected) {
            failed++;
            firstError ??= rejected.error ?? "audio import failed";
          }
        }
      } catch (reason) {
        if (!cancelQueue.current) {
          failed++;
          firstError ??= String(reason);
        }
      }
    }
    if (failed > 0) {
      setError(`${failed} file(s) failed: ${firstError}`);
      finishProgress(firstError);
    } else {
      finishProgress(cancelQueue.current ? "import cancelled" : null);
    }
    if (existing > 0) showNotice(`${existing} existing track${existing === 1 ? "" : "s"} already in library`);
    if (added > 0) {
      setDragCount(added);
      setTimeout(() => setDragCount(null), 3000);
    }
    setImportBusy(false);
    onImported();
  };

  useEffect(() => {
    const handleMenuCommand = (event: Event) => {
      const command = (event as CustomEvent<AppMenuCommand>).detail;
      void importFromMenu(command);
    };
    window.addEventListener("olooper:import-command", handleMenuCommand);
    return () => window.removeEventListener("olooper:import-command", handleMenuCommand);
  }, [busy]);

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

      {notice && <div className="fixed left-1/2 top-12 z-[80] -translate-x-1/2 rounded border border-success/40 bg-surface px-4 py-3 text-xs text-success shadow-xl" role="status">{notice}</div>}

      {modePrompt && (
        <div ref={modeDialogRef} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="container-import-title" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            modePrompt.resolve(null);
            setModePrompt(null);
          } else if (event.key === "Tab") {
            const buttons = modeDialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
            if (!buttons?.length) return;
            const first = buttons[0];
            const last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 id="container-import-title" className="text-sm font-semibold text-text">Import SWF/EXE audio</h2>
            <p className="mt-2 text-xs text-text-secondary">Choose how to handle the audio in the selected file(s).</p>
            <div className="mt-4 flex flex-col gap-2">
              <button onClick={() => { modePrompt.resolve("extract"); setModePrompt(null); }} className="rounded border border-border bg-elevated px-3 py-2 text-left text-xs text-text hover:border-accent">Extract audio</button>
              <button onClick={() => { modePrompt.resolve("embedded"); setModePrompt(null); }} className="rounded border border-border bg-elevated px-3 py-2 text-left text-xs text-text hover:border-accent">Play from source (no extraction)</button>
              <button onClick={() => { modePrompt.resolve(null); setModePrompt(null); }} className="self-end px-2 py-1 text-[10px] text-text-secondary hover:text-text">Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center gap-1 border-l border-border pl-2">
        <BrowseBtn
          onClick={() => browseAndImport((path, jobId, mode) => importSwfAndWait(path, jobId, mode === "extract"), [
            { name: "Flash files", extensions: ["swf"] },
          ])}
          disabled={busy}
          label="SWF"
        />
        <BrowseBtn
          onClick={() => browseAndImport((path, jobId, mode) => importExeAndWait(path, jobId, mode === "extract"), [
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
        {progress && !progress.done && (
          <div className="flex items-center gap-2">
            <span className="max-w-24 truncate text-[9px] text-accent animate-pulse">{progress.stage}</span>
            {progress.total > 0 && (
              <span className="text-[10px] text-text-secondary">{progress.current}/{progress.total}</span>
            )}
            {busy && (
              <button onClick={requestCancel} className="text-[9px] text-danger hover:text-danger/80 transition-colors">×</button>
            )}
          </div>
        )}

        {dragCount !== null && (
          <span className="text-[9px] text-success">+{dragCount}</span>
        )}
        {report && report.added > 0 && (
          <span className="text-[10px] text-text-secondary">
            {report.added > 0 && <span className="text-success">+{report.added}</span>}
          </span>
        )}
        {error && (
          <div className="flex min-w-0 items-center gap-1" role="alert">
            <span
              className={`max-w-20 truncate text-[9px] ${error === "already in library" ? "text-text-secondary" : "text-danger"}`}
              title={error}
            >
              {error}
            </span>
          </div>
        )}
      </div>

      {progress && files.length > 0 && (
        <div className="fixed right-3 top-12 z-[80] w-[min(28rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-surface px-4 py-2 shadow-xl">
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
