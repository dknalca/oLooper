import { useEffect, useState } from "react";
import {
  playerLoad,
  playerPause,
  playerPlay,
  playerSetLoop,
  playerSetLoopEnabled,
  playerSetVolume,
  playerStatus,
  playerStop,
  type PlayerStatus,
} from "../tauri";

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(
    Math.floor((ms % 1000) / 100),
  )}`;
}

export default function Player() {
  const [path, setPath] = useState("");
  const [st, setSt] = useState<PlayerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loopStart, setLoopStart] = useState("0");
  const [loopEnd, setLoopEnd] = useState("");

  const run = (p: Promise<PlayerStatus>) =>
    p.then((s) => {
      setSt(s);
      setError(null);
      setLoopStart(String(s.loop_start_ms));
      setLoopEnd(String(s.loop_end_ms));
    }).catch((e) => setError(String(e)));

  useEffect(() => {
    if (!st?.playing) return;
    const id = setInterval(() => playerStatus().then(setSt).catch(() => {}), 250);
    return () => clearInterval(id);
  }, [st?.playing]);

  return (
    <section>
      <h2>Player</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          aria-label="Audio file path"
          placeholder="/absolute/path/to/loop.mp3"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          style={{ flex: 1 }}
        />
        <button onClick={() => run(playerLoad(path))}>Load</button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => run(playerPlay())} disabled={!st?.loaded}>
          {st?.playing ? "Playing…" : "Play"}
        </button>
        <button onClick={() => run(playerPause())} disabled={!st?.playing}>
          Pause
        </button>
        <button onClick={() => run(playerStop())} disabled={!st?.loaded}>
          Stop
        </button>
        <label>
          Vol
          <input
            type="range"
            min={0}
            max={100}
            value={st?.volume_pct ?? 80}
            onChange={(e) => run(playerSetVolume(Number(e.target.value)))}
          />
        </label>
      </div>
      {st?.loaded && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <label>
            Loop
            <input
              type="checkbox"
              checked={st.loop_enabled}
              onChange={(e) => run(playerSetLoopEnabled(e.target.checked))}
            />
          </label>
          <input
            aria-label="Loop start ms"
            value={loopStart}
            onChange={(e) => setLoopStart(e.target.value)}
            style={{ width: 90 }}
          />
          <input
            aria-label="Loop end ms"
            value={loopEnd}
            onChange={(e) => setLoopEnd(e.target.value)}
            style={{ width: 90 }}
          />
          <button onClick={() => run(playerSetLoop(Number(loopStart), Number(loopEnd)))}>
            Set loop
          </button>
          <span>
            {fmt(st.position_ms)} / {fmt(st.duration_ms)}
          </span>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
