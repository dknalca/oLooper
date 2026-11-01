import { useEffect, useRef, useState, type RefObject } from "react";
import { playerSeek, type PlayerStatus } from "../tauri";

/** Own mouse scrubbing and stop stale drags when the playback owner changes. */
export function usePlayerScrub(
  status: PlayerStatus | null,
  matchesPlayback: boolean,
  statusRef: RefObject<PlayerStatus | null>,
  ownerRef: RefObject<string>,
  setError: (error: string) => void,
) {
  const scrubRef = useRef<HTMLDivElement>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const onScrubDown = (event: React.MouseEvent<HTMLDivElement>) => {
    setIsScrubbing(true);
    if (!scrubRef.current || !status?.loaded || status.loading || !matchesPlayback || status.duration_ms <= 0) return;
    const rect = scrubRef.current.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    playerSeek(Math.round(fraction * status.duration_ms)).catch((cause) => setError(String(cause)));
  };

  useEffect(() => {
    if (!isScrubbing) return;
    const owner = ownerRef.current;
    const onMove = (event: MouseEvent) => {
      if (owner !== ownerRef.current || statusRef.current?.loading) return;
      if (!scrubRef.current || !status?.loaded || status.duration_ms <= 0) return;
      const rect = scrubRef.current.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      playerSeek(Math.round(fraction * status.duration_ms)).catch(() => {});
    };
    const onUp = () => setIsScrubbing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isScrubbing, status?.loaded, status?.duration_ms, ownerRef, statusRef]);

  return { scrubRef, onScrubDown };
}
