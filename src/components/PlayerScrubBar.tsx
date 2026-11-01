import type { RefObject } from "react";
import { usePlayerScrub } from "../hooks/usePlayerScrub";
import { playerSeek, type PlayerStatus } from "../tauri";

interface Props {
  status: PlayerStatus | null;
  matchesPlayback: boolean;
  loaded: boolean;
  statusRef: RefObject<PlayerStatus | null>;
  ownerRef: RefObject<string>;
  setError: (error: string) => void;
  run: (request: Promise<PlayerStatus>) => void;
}

/** Accessible playback position control, including mouse-drag lifecycle. */
export default function PlayerScrubBar({ status: st, matchesPlayback, loaded, statusRef, ownerRef, setError, run }: Props) {
  const { scrubRef, onScrubDown } = usePlayerScrub(st, matchesPlayback, statusRef, ownerRef, setError);
  const posFrac = st?.loaded && st.duration_ms > 0 ? st.position_ms / st.duration_ms : 0;
  return <div
    ref={scrubRef} role="slider" tabIndex={loaded ? 0 : -1} aria-label="Playback position"
    aria-valuemin={0} aria-valuemax={st?.duration_ms ?? 0} aria-valuenow={st?.position_ms ?? 0} aria-disabled={!loaded}
    onKeyDown={(event) => {
      if (!loaded) return;
      const position = st?.position_ms ?? 0;
      const target = event.key === "Home" ? 0 : event.key === "End" ? st?.duration_ms ?? 0
        : event.key === "ArrowLeft" ? position - 1000 : event.key === "ArrowRight" ? position + 1000 : null;
      if (target !== null) { event.preventDefault(); event.stopPropagation(); run(playerSeek(Math.max(0, Math.min(st?.duration_ms ?? 0, target)))); }
    }}
    onMouseDown={onScrubDown}
    className={`relative h-2 overflow-hidden rounded-full cursor-pointer group ${loaded ? "bg-border" : "bg-border/50"}`}
  >
    {loaded && <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-hidden pointer-events-none" aria-hidden="true">
      <line x1="0" y1="5" x2={posFrac * 100} y2="5" className="stroke-accent" strokeWidth="10" strokeLinecap="round" />
      <circle cx={posFrac * 100} cy="5" r="4" className="fill-accent opacity-0 group-hover:opacity-100 transition-opacity" />
    </svg>}
  </div>;
}
