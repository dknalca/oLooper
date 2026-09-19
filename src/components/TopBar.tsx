import { useEffect, useState } from "react";
import {
  getAppStatus,
  libraryDefaultRoot,
  libraryInit,
  libraryRestore,
  pickDirectory,
  type AppStatus,
} from "../tauri";
import Logo from "./Logo";

interface Props {
  onLibraryReady: (root: string) => void;
}

export default function TopBar({ onLibraryReady }: Props) {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [root, setRoot] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAppStatus(), libraryDefaultRoot(), libraryRestore()])
      .then(([appStatus, defaultRoot, savedRoot]) => {
        if (cancelled) return;
        setRoot(savedRoot ?? defaultRoot);
        setStatus({ ...appStatus, library_set: savedRoot !== null });
        if (savedRoot) onLibraryReady(savedRoot);
        else setSetupOpen(true);
      })
      .catch((e) => !cancelled && setError(`Could not prepare library: ${String(e)}`));
    return () => { cancelled = true; };
  }, [onLibraryReady]);

  const browseRoot = async () => {
    const selected = await pickDirectory();
    if (selected) setRoot(selected);
  };

  const init = () => {
    setInitializing(true);
    setError(null);
    libraryInit(root)
      .then((libraryRoot) => {
        setStatus((current) => current ? { ...current, library_set: true } : current);
        setRoot(libraryRoot);
        setSetupOpen(false);
        onLibraryReady(libraryRoot);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setInitializing(false));
  };

  return (
    <>
      <header className="flex items-center gap-3 px-4 h-10 border-b border-border bg-surface shrink-0 select-none">
        <div className="flex items-center gap-2">
          <Logo className="h-6 w-6" />
          <span className="font-semibold text-sm tracking-wide text-text">oLooper</span>
        </div>
        {status && (
          <>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary">v{status.version}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-secondary">{status.platform}</span>
            <button
              onClick={() => setSetupOpen(true)}
              className={`text-[10px] px-1.5 py-0.5 rounded ${status.library_set ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}
            >
              {status.library_set ? "library ready" : "set library"}
            </button>
          </>
        )}
        {root && <span className="ml-auto truncate max-w-64 text-[10px] text-text-secondary" title={root}>{root}</span>}
        {error && <span className="text-xs text-danger" role="alert">{error}</span>}
      </header>

      {setupOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-app/80 backdrop-blur-sm">
          <div className="w-[28rem] rounded-lg border border-border bg-surface p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-text">Choose your library folder</h2>
            <p className="mt-1 text-xs text-text-secondary">Audio will be stored here. The suggested portable location is `./library` next to oLooper.</p>
            <div className="mt-4 flex gap-2">
              <input
                aria-label="Library root path"
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-elevated px-2 py-1.5 text-xs text-text focus:border-accent"
              />
              <button onClick={browseRoot} className="rounded bg-border px-3 text-xs text-text-secondary hover:text-text">Browse</button>
            </div>
            {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end">
              <button
                onClick={init}
                disabled={initializing || !root}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-app disabled:opacity-40"
              >
                {initializing ? "Preparing…" : "Use this folder"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
