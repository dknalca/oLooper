import { useEffect, useRef, useState } from "react";
import { createRandomPlayback, type RandomSwitchOptions } from "../randomPlayback";
import type { PlayerStatus } from "../tauri";
import type { RandomInterval } from "../components/RandomPlaybackControls";

/** Own the Random clock, its latest action and its window subscription. */
export function useRandomPlayback(
  status: PlayerStatus | null,
  canRandom: boolean,
  onRandomTrack: (request?: RandomSwitchOptions) => Promise<boolean | void>,
  setError: (error: string | null) => void,
) {
  const [enabled, setEnabled] = useState(false);
  const [interval, setInterval] = useState<RandomInterval>("2");
  const [customMinutes, setCustomMinutes] = useState("10");
  const [remaining, setRemaining] = useState<number | null>(null);
  const actionRef = useRef(onRandomTrack);
  actionRef.current = onRandomTrack;
  const [playback] = useState(() => createRandomPlayback({
    action: (request) => actionRef.current(request),
    onRemaining: setRemaining,
    onSuccess: () => setError(null),
    onError: (cause) => setError(`Random track: ${String(cause)}`),
  }));
  const minutes = interval === "custom" ? Number(customMinutes) : Number(interval);
  const validInterval = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440;

  useEffect(() => {
    playback.configure(enabled && canRandom && validInterval ? minutes * 60_000 : null);
    return () => playback.configure(null);
  }, [enabled, canRandom, validInterval, minutes, playback]);
  useEffect(() => { playback.updatePlayback(status); }, [status, playback]);
  useEffect(() => {
    const random = () => { if (canRandom) void playback.trigger(); };
    window.addEventListener("olooper:random-loop", random);
    return () => window.removeEventListener("olooper:random-loop", random);
  }, [canRandom, playback]);

  return { enabled, setEnabled, interval, setInterval, customMinutes, setCustomMinutes, remaining, validInterval, trigger: playback.trigger };
}
