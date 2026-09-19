import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  importCustom,
  importExe,
  importSwf,
  libraryInit,
  libraryList,
  playerLoad,
  playerPlay,
  type ImportReport,
  type Track,
} from "../tauri";

export default function Library() {
  const [root, setRoot] = useState("");
  const [readyRoot, setReadyRoot] = useState<string | null>(null);
  const [importPath, setImportPath] = useState("");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = () =>
    libraryList().then(setTracks).catch((e) => setError(String(e)));

  // Webview drag&drop: dropped audio files import as custom loops.
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
          importCustom(paths)
            .then((rs) => {
              const failed = rs.filter((r) => !r.added && r.error !== "already in library");
              setError(
                failed.length > 0
                  ? `${failed.length} file(s) failed: ${failed[0].error}`
                  : null,
              );
              return refresh();
            })
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        } else {
          setDragging(false);
        }
      })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    return () => off?.();
  }, []);

  const init = () =>
    libraryInit(root)
      .then((r) => {
        setReadyRoot(r);
        setError(null);
        return refresh();
      })
      .catch((e) => setError(String(e)));

  const doImport = (fn: (p: string) => Promise<ImportReport>) => {
    setBusy(true);
    fn(importPath)
      .then((r) => {
        setReport(r);
        setError(r.failed.length > 0 ? `${r.failed.length} sounds failed` : null);
        return refresh();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const playTrack = (t: Track) =>
    playerLoad(t.file_path)
      .then(() => playerPlay())
      .catch((e) => setError(String(e)));

  return (
    <section style={{ position: "relative" }}>
      <h2>Library</h2>
      {dragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(74, 163, 255, 0.15)",
            border: "2px dashed #4aa3ff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          Drop audio to import as custom loop
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          aria-label="Library root path"
          placeholder="/absolute/path/to/library"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={init}>Init</button>
        {readyRoot && <span>root: {readyRoot}</span>}
      </div>
      {readyRoot && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            aria-label="SWF or EXE path to import"
            placeholder="/absolute/path/to/looper.swf"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            style={{ flex: 1 }}
          />
          <button disabled={busy} onClick={() => doImport(importSwf)}>
            Import SWF
          </button>
          <button disabled={busy} onClick={() => doImport(importExe)}>
            Import EXE
          </button>
          <button
            disabled={busy}
            title="Import a WAV/MP3 path as custom loop (or drag&drop files here)"
            onClick={() => {
              setBusy(true);
              importCustom([importPath])
                .then((rs) => {
                  setError(rs[0]?.error === "already in library" ? "already in library" : (rs[0]?.error ?? null));
                  return refresh();
                })
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Import audio
          </button>
        </div>
      )}
      {report && (
        <p>
          {report.looper}: +{report.added} new, {report.already_there} already there
        </p>
      )}
      <ul>
        {tracks.map((t) => (
          <li key={t.id}>
            <button onClick={() => playTrack(t)} disabled={!t.exists}>
              ▶
            </button>{" "}
            {t.title} ({(t.duration_ms / 1000).toFixed(1)}s)
            {!t.exists && " — file missing"}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
