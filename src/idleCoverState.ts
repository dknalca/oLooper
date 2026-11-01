import type { PlayerStatus, Track } from "./tauri";

export interface ActiveCoverState {
  sourceHash: string;
  generation: number;
  src: string | null;
  pending: boolean;
}

/** Resolve a cover against the selected track and library generation. */
export function idleCoverContext(track: Track | null, status: PlayerStatus | null, cover: ActiveCoverState | null, libraryGeneration: number) {
  const committed = !!track && status?.path === track.playback_path;
  const ownedCover = cover?.generation === libraryGeneration && cover.sourceHash === track?.source_hash ? cover : null;
  const src = ownedCover && !ownedCover.pending ? ownedCover.src : null;
  const path = track?.playback_path ?? null;
  const title = track?.title ?? "Looper";
  const key = src && path ? `${libraryGeneration}|${path}|${src}` : null;
  return { committed, ownedCover, src, path, title, key };
}

/** Decide entry and retention separately so a pending switch can keep its cover. */
export function idleCoverEligibility(
  context: ReturnType<typeof idleCoverContext>,
  track: Track | null,
  status: PlayerStatus | null,
  ready: boolean,
  loadedKey: string | null,
  failedKey: string | null,
  hasCurrentImage: boolean,
) {
  const { key, committed, ownedCover } = context;
  const valid = !!key && loadedKey === key && failedKey !== key && committed;
  const loadingImage = !!key && loadedKey !== key && failedKey !== key;
  const waitingForCover = committed && track?.source_type !== "custom" && (!ownedCover || ownedCover.pending);
  const switching = status?.loading || (!!track && !committed && !status?.load_error);
  const playing = ready && status?.loaded === true && status.playing;
  return {
    canEnter: playing && !switching && valid,
    canRemain: playing && hasCurrentImage && (valid || loadingImage || waitingForCover || !!switching),
  };
}
