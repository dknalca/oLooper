import type { PlayerStatus } from "../tauri";

interface Props {
  status: PlayerStatus | null;
  loaded: boolean;
  onVolume: (value: number) => void;
  onSpeed: (value: number) => void;
}

/** Volume and speed controls; the parent owns native commands and errors. */
export default function PlayerAudioControls({ status, loaded, onVolume, onSpeed }: Props) {
  const volume = status?.volume_pct ?? 80;
  const speed = status?.speed_pct ?? 100;
  return <>
    <div className="flex items-center gap-1.5">
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-text-secondary shrink-0">
        <path d="M2 5.5h2.5L8 2.5v11l-3.5-3H2a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z" />
        {volume > 0 && <path d="M10 5.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-text-secondary" />}
        {volume > 50 && <path d="M11.5 3.5a6 6 0 010 9" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-text-secondary" />}
      </svg>
      <input type="range" min={0} max={100} value={volume} onChange={(event) => onVolume(Number(event.target.value))} aria-label="Volume" className="w-16" />
    </div>
    <div className="w-px h-5 bg-border" />
    <div className="flex items-center gap-1">
      <span className="mr-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">Pitch</span>
      <button onClick={() => onSpeed(Math.max(50, speed - 5))} disabled={!loaded} title="Slower" className="rounded bg-border px-1.5 py-0.5 text-xs text-text-secondary hover:text-text disabled:opacity-30">−</button>
      <span className="w-9 text-center font-mono text-[10px] text-text-secondary">{Math.round(speed)}%</span>
      <button onClick={() => onSpeed(Math.min(200, speed + 5))} disabled={!loaded} title="Faster" className="rounded bg-border px-1.5 py-0.5 text-xs text-text-secondary hover:text-text disabled:opacity-30">+</button>
    </div>
  </>;
}
