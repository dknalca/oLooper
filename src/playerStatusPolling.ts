import { createSharedPolling } from "./sharedPolling";
import { playerStatus, type PlayerStatus } from "./tauri";

const polling = createSharedPolling(() => playerStatus());

/** Prepare each receiver before the read so callers can retain ownership guards. */
export function startPlayerStatusPolling(
  prepare: () => (status: PlayerStatus) => void,
  intervalMs: number,
  immediate = true,
): () => void {
  return polling.subscribe(prepare, intervalMs, immediate);
}
