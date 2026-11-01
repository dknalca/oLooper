import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ownSubscription } from "../subscription";
import { useImportJobs } from "../hooks/useImportJobs";
import { libraryLinkFolder, libraryLinkedFolders, librarySourceFolders, libraryRescanFolder, importLinkedFileAndWait, type LinkedFolder } from "../tauri";
import {
  importCustomAndWait,
  importExeAndWait,
  importSwfAndWait,
  type AppMenuCommand,
  pickFiles,
  pickDirectory,
  scanLooperFolder,
  type ImportReport,
} from "../tauri";
import { copySourcePreference, importKindForPath, type ContainerImportOptions } from "../importFlow";
import { importMixedFiles } from "../mixedImport";
import { containerImportMessages, importContainerFiles, importRescannedFiles } from "../containerImport";
import ImportProgressPanel from "./ImportProgressPanel";

interface Props {
  onImported: () => void;
}

function importContainer(path: string, jobId: string, options: ContainerImportOptions): Promise<ImportReport> {
  const run = importKindForPath(path) === "exe" ? importExeAndWait : importSwfAndWait;
  return run(path, jobId, options.mode === "extract", options.copySource);
}

const LOOPER_FILTERS = [{ name: "SWF/EXE loopers", extensions: ["swf", "exe"] }];

export default function ImportBar({ onImported }: Props) {
  const [modePrompt, setModePrompt] = useState<{ count: number; folder?: string; resolve: (options: ContainerImportOptions | null) => void } | null>(null);
  const [promptCopySource, setPromptCopySource] = useState(false);
  const [folders, setFolders] = useState<LinkedFolder[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragCount, setDragCount] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const internalTrackDrag = useRef(false);
  const modeDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modePrompt) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    modeDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previousFocus?.focus();
  }, [modePrompt]);
  const { busy, busyRef, setImportBusy, progress, setProgress, files, elapsed, cancelQueue, runOwnedJob, beginImport, requestCancel, finishProgress } = useImportJobs(setError);

  const chooseContainerMode = (paths: string[], folder?: string): Promise<ContainerImportOptions | null> => {
    const count = paths.filter((path) => ["swf", "exe"].includes(importKindForPath(path))).length;
    const copySource = copySourcePreference(localStorage.getItem("olooper.import.copy-source"));
    if (count === 0) return Promise.resolve({ mode: "embedded", copySource });
    setPromptCopySource(copySource);
    return new Promise((resolve) => setModePrompt({ count, folder, resolve }));
  };

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  };

  const runMixedImport = async (paths: string[], options: ContainerImportOptions, failureLabel: string, refreshBeforeRelease: boolean) => {
    const { added, existing, failed, firstError } =
      await importMixedFiles(paths, options, runOwnedJob, () => cancelQueue.current, failureLabel);
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
    if (refreshBeforeRelease) onImported();
    setImportBusy(false);
    if (!refreshBeforeRelease) onImported();
  };

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

  // Webview drag&drop
  useEffect(() => {
    return ownSubscription(getCurrentWebview()
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
            await runMixedImport(paths, containerMode, "import failed", true);
          })();
        } else {
          setDragging(false);
        }
      })
      , (e) => setError(`Drag and drop unavailable: ${String(e)}`));
  }, [onImported]);

  const browseAndImport = async (
    importFn: (p: string, jobId: string, options: ContainerImportOptions) => Promise<ImportReport>,
    filters: { name: string; extensions: string[] }[],
    folderImport = false,
  ) => {
    if (busyRef.current) return;
    setImportBusy(true);
    let files: string[];
    let folder: string | undefined;
    try {
      if (folderImport) {
        const selected = await pickDirectory();
        if (!selected) { setImportBusy(false); return; }
        folder = selected;
        showNotice("Scanning folder and subfolders for SWF/EXE loopers…");
        files = await scanLooperFolder(selected);
        setNotice(null);
        if (files.length === 0) showNotice("No SWF/EXE loopers found in this folder or its subfolders.");
      } else {
        files = await pickFiles(filters);
      }
    } catch (cause) {
      setNotice(null);
      setError(String(cause));
      setImportBusy(false);
      return;
    }
    if (files.length === 0 && !folder) {
      setImportBusy(false);
      return;
    }
    const containerMode = await chooseContainerMode(files, folder);
    if (!containerMode) { setImportBusy(false); return; }
    let linked: LinkedFolder | undefined;
    if (folder) {
      try {
        linked = await libraryLinkFolder(folder, containerMode.mode === "extract", containerMode.copySource);
      } catch (cause) {
        setError(String(cause));
        setImportBusy(false);
        return;
      }
    }
    beginImport(files);
    setError(null);
    setReport(null);
    const result = await importContainerFiles(files, (path) => runOwnedJob(path, (jobId) => linked
        ? importLinkedFileAndWait(linked, path, jobId)
        : importFn(path, jobId, containerMode)), () => cancelQueue.current, Boolean(linked));
    const { error, progressError } = containerImportMessages(result, cancelQueue.current);
    if (result.lastReport) setReport(result.lastReport);
    if (error) setError(error);
    if (result.added > 0) {
      setDragCount(result.added);
      setTimeout(() => setDragCount(null), 3000);
    }
    if (result.existing > 0) showNotice(`${result.existing} existing track${result.existing === 1 ? "" : "s"} already in library`);
    finishProgress(progressError);
    setImportBusy(false);
    onImported();
  };

  const openFolders = async (sourceHash?: string) => {
    if (busyRef.current) return;
    try {
      setFolders(await (sourceHash ? librarySourceFolders(sourceHash) : libraryLinkedFolders()));
    } catch (cause) { setError(String(cause)); }
  };

  const rescanFolder = async (folder: LinkedFolder) => {
    if (busyRef.current) return;
    setFolders(null);
    setImportBusy(true);
    setError(null);
    setReport(null);
    cancelQueue.current = false;
    setNotice(`Scanning ${folder.path}…`);
    try {
      const scan = await libraryRescanFolder(folder);
      onImported();
      beginImport(scan.paths);
      const { added, failed, errors } = await importRescannedFiles(scan.paths,
        (path) => runOwnedJob(path, (jobId) => importLinkedFileAndWait(folder, path, jobId)),
        () => cancelQueue.current);
      const failure = errors[0] ?? (failed ? `${failed} sound(s) failed` : null);
      setError(failure);
      finishProgress(cancelQueue.current ? "import cancelled" : failure);
      showNotice(`${cancelQueue.current ? "Rescan cancelled" : "Rescan complete"}: ${added} added, ${scan.removed} missing track(s) removed, ${scan.unchanged} unchanged looper(s)${failed ? `, ${failed} failed` : ""}.`);
    } catch (cause) {
      setNotice(null);
      setError(String(cause));
      finishProgress(String(cause));
    } finally {
      setImportBusy(false);
      onImported();
    }
  };

  useEffect(() => {
    const handle = (event: Event) => { void openFolders((event as CustomEvent<string>).detail); };
    window.addEventListener("olooper:rescan-source-folder", handle);
    return () => window.removeEventListener("olooper:rescan-source-folder", handle);
  }, []);

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
    if (command === "import-loopers") {
      await browseAndImport(importContainer, LOOPER_FILTERS);
      return;
    }
    if (command === "import-folder") {
      await browseAndImport(importContainer, LOOPER_FILTERS, true);
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
    await runMixedImport(paths, containerMode, "audio import failed", false);
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

      {folders !== null && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="linked-folders-title" onKeyDown={(event) => { if (event.key === "Escape") setFolders(null); }}>
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 id="linked-folders-title" className="text-sm font-semibold text-text">Source folders</h2>
            <p className="mt-2 text-xs text-text-secondary">Rescan for new or changed SWF/EXE loopers. Existing extracted audio is kept; only tracks whose required audio is missing are removed. Unavailable folders leave the library untouched.</p>
            {folders.length === 0 && <p className="mt-4 text-xs text-text-secondary">No linked folder found. Import the original folder once to remember its path.</p>}
            <div className="mt-4 space-y-3">
              {folders.map((folder) => <div key={folder.id} className="flex items-center gap-3 rounded border border-border p-3">
                <div className="min-w-0 flex-1"><p className="break-all text-xs text-text">{folder.path}</p><p className="mt-1 text-[10px] text-text-secondary">Including subfolders · {folder.extract_audio ? "Extract audio" : "Play from source"}{folder.copy_source ? " · Copy source" : ""}</p></div>
                <button onClick={() => void rescanFolder(folder)} className="toolbar-button shrink-0">Rescan</button>
              </div>)}
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button onClick={() => { setFolders(null); void browseAndImport(importContainer, LOOPER_FILTERS, true); }} className="toolbar-button">Import folder…</button>
              <button onClick={() => setFolders(null)} className="dialog-close">Close</button>
            </div>
          </div>
        </div>
      )}

      {modePrompt && (
        <div ref={modeDialogRef} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="container-import-title" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            modePrompt.resolve(null);
            setModePrompt(null);
          } else if (event.key === "Tab") {
            const buttons = modeDialogRef.current?.querySelectorAll<HTMLElement>("button, input");
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
          <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 id="container-import-title" className="text-sm font-semibold text-text">Import SWF/EXE audio</h2>
            <p className="mt-2 text-xs text-text-secondary">You are about to import <strong className="text-text">{modePrompt.count} looper{modePrompt.count === 1 ? "" : "s"}</strong>. Choose how to handle their audio.</p>
            {modePrompt.folder && <p className="mt-2 break-all text-[10px] text-text-secondary">Folder: {modePrompt.folder} (including subfolders)</p>}
            <label className="mt-4 flex items-start gap-2 rounded border border-border bg-elevated p-3 text-xs text-text">
              <input type="checkbox" checked={promptCopySource} onChange={(event) => setPromptCopySource(event.target.checked)} className="mt-0.5" />
              <span>Copy SWF/EXE loopers to the library<span className="mt-1 block text-[10px] text-text-secondary">Applies to this import. Without a copy, source playback needs the original files to remain in place. Extracted audio is always stored in the library.</span></span>
            </label>
            <div className="mt-4 flex flex-col gap-2">
              <button onClick={() => { modePrompt.resolve({ mode: "embedded", copySource: promptCopySource }); setModePrompt(null); }} className="rounded border border-accent bg-accent/10 px-3 py-2 text-left text-xs text-text hover:bg-accent/20">Play from source (no extraction)</button>
              <button onClick={() => { modePrompt.resolve({ mode: "extract", copySource: promptCopySource }); setModePrompt(null); }} className="rounded border border-border bg-elevated px-3 py-2 text-left text-xs text-text hover:border-accent">Extract audio</button>
              <button onClick={() => { modePrompt.resolve(null); setModePrompt(null); }} className="dialog-close self-end">Cancel import</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-8 shrink-0 items-center gap-1 border-l border-border pl-2">
        <BrowseBtn
          onClick={() => browseAndImport(importContainer, LOOPER_FILTERS)}
          disabled={busy}
          label="SWF / EXE"
        />
        <BrowseBtn
          onClick={() => void openFolders()}
          disabled={busy}
          label="Folder"
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

      <ImportProgressPanel progress={progress} files={files} elapsed={elapsed} onDismiss={() => setProgress(null)} />

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
