import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { playerAutoLoop, playerSetLoopSnapped, type PlayerStatus } from "../tauri";

/** Own loop drafts and analysis while applying changes to the opened generation. */
export function usePlayerLoopEditor(
  status: PlayerStatus | null,
  statusRef: MutableRefObject<PlayerStatus | null>,
  ownerRef: MutableRefObject<string>,
  setError: (error: string) => void,
  run: (request: Promise<PlayerStatus>) => void,
) {
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");

  useEffect(() => {
    if (!status?.loaded) {
      setStart("0");
      setEnd("");
      return;
    }
    if (document.activeElement !== startRef.current) setStart(String(status.loop_start_ms));
    if (document.activeElement !== endRef.current) setEnd(String(status.loop_end_ms));
  }, [status?.path, status?.loaded, status?.loop_start_ms, status?.loop_end_ms]);

  const apply = () => {
    const startMs = Number(start);
    const endMs = Number(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setError("Loop boundaries must be valid times in milliseconds.");
      return;
    }
    run(playerSetLoopSnapped(startMs, endMs, statusRef.current?.generation));
  };

  const detect = () => {
    const owner = ownerRef.current;
    const generation = statusRef.current?.generation;
    run(playerAutoLoop().then((result) => {
      if (owner !== ownerRef.current) throw new Error("Track changed during analysis");
      if (!result.candidate) throw new Error("No suitable loop found");
      return playerSetLoopSnapped(
        Math.round(result.candidate.start_frame * 1000 / result.sample_rate),
        Math.round(result.candidate.end_frame * 1000 / result.sample_rate),
        generation,
      );
    }));
  };
  return { startRef, endRef, start, end, setStart, setEnd, apply, detect };
}
