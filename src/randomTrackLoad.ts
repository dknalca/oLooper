import { takeRandomCandidate, type RandomCandidate } from "./randomCandidate";
import type { RandomSwitchOptions } from "./randomPlayback";
import {
  libraryRandomTrack, playerCancelBoundaryLoad, playerLoadTrack, playerPlay, playerStatus,
  type PlayerStatus, type Track,
} from "./tauri";

interface RandomTrackLoadContext {
  activeTrackId: number | null;
  libraryGeneration: number;
  libraryView: "local" | "tablist";
  randomScopeHash: string | null;
  loadGeneration: { current: number };
  candidate: { current: RandomCandidate | null };
  onStatus: (status: PlayerStatus) => void;
  onCommit: (track: Track, status: PlayerStatus) => void;
}

/** Load the selected random track, abandoning superseded work before publishing. */
export async function loadRandomTrack(context: RandomTrackLoadContext, request?: RandomSwitchOptions): Promise<boolean | void> {
  if (request?.signal?.aborted) return;
  const { activeTrackId, libraryGeneration, libraryView, randomScopeHash, loadGeneration, candidate, onStatus, onCommit } = context;
  const generation = ++loadGeneration.current;
  let admitted = false;
  const cancelQueued = () => { if (admitted) void playerCancelBoundaryLoad().catch(() => {}); };
  request?.signal?.addEventListener("abort", cancelQueued);
  try {
    const scope = libraryView === "local" ? randomScopeHash : null;
    const key = `${libraryGeneration}|${libraryView}|${scope ?? ""}`;
    const prepared = candidate.current;
    candidate.current = null;
    const track = takeRandomCandidate(prepared, key, activeTrackId) ?? await libraryRandomTrack(activeTrackId, scope);
    if (!track) throw new Error("No playable tracks in the current selection");
    if (generation !== loadGeneration.current || request?.signal?.aborted) return;
    let status = request?.atLoopEnd ? await playerLoadTrack(track.id, true) : await playerLoadTrack(track.id);
    admitted = true;
    if (request?.signal?.aborted) status = await playerCancelBoundaryLoad();
    if (generation !== loadGeneration.current) return;
    onStatus(status);
    const deadline = Date.now() + 120_000;
    while ((status.loading || status.boundary_pending) && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (generation !== loadGeneration.current) return;
      status = await playerStatus();
      if (generation !== loadGeneration.current) return;
      onStatus(status);
    }
    if (generation !== loadGeneration.current) return;
    if (status.loading || status.boundary_pending) {
      if (request?.atLoopEnd) await playerCancelBoundaryLoad();
      throw new Error("Random track load timed out");
    }
    if (status.load_error) throw new Error(status.load_error);
    if (status.path !== track.playback_path) return false;
    const playing = request?.atLoopEnd ? status : await playerPlay();
    if (generation !== loadGeneration.current) return;
    onCommit(track, playing);
  } finally {
    request?.signal?.removeEventListener("abort", cancelQueued);
  }
}
