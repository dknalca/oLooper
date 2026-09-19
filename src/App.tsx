import { useEffect, useState } from "react";
import { getAppStatus, type AppStatus } from "./tauri";
import Player from "./components/Player";
import Library from "./components/Library";
import Waveform from "./components/Waveform";

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAppStatus().then(setStatus).catch((e) => setError(String(e)));
  }, []);

  return (
    <main
      style={{
        background: "#111",
        color: "#eee",
        minHeight: "100vh",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>oLooper</h1>
      {error && <p role="alert">Backend unreachable: {error}</p>}
      {!status && !error && <p>Connecting to core…</p>}
      {status && (
        <ul>
          <li>version: {status.version}</li>
          <li>platform: {status.platform}</li>
          <li>library: {status.library_set ? "set" : "not set yet"}</li>
        </ul>
      )}
      <Player />
      <Waveform />
      <Library />
    </main>
  );
}
