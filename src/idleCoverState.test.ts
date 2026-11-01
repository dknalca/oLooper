import { expect, it } from "vitest";
import { idleCoverContext, idleCoverEligibility, type ActiveCoverState } from "./idleCoverState";
import type { PlayerStatus, Track } from "./tauri";

const track = { playback_path: "embedded:1", source_hash: "hash", source_type: "swf", title: "Beat" } as Track;
const status = { path: "embedded:1", loaded: true, playing: true, loading: false, load_error: null } as PlayerStatus;
const cover: ActiveCoverState = { sourceHash: "hash", generation: 4, src: "cover.jpg", pending: false };

it("only accepts the current library and track cover", () => {
  expect(idleCoverContext(track, status, cover, 4)).toMatchObject({ committed: true, src: "cover.jpg", key: "4|embedded:1|cover.jpg", title: "Beat" });
  expect(idleCoverContext(track, status, cover, 5)).toMatchObject({ committed: true, ownedCover: null, key: null });
  expect(idleCoverContext(track, status, { ...cover, sourceHash: "other" }, 4).key).toBeNull();
  expect(idleCoverContext(null, status, cover, 4)).toMatchObject({ committed: false, key: null, title: "Looper" });
});

it("enters only with a loaded matching image while playing", () => {
  const context = idleCoverContext(track, status, cover, 4);
  const key = context.key;
  expect(idleCoverEligibility(context, track, status, true, key, null, true)).toEqual({ canEnter: true, canRemain: true });
  expect(idleCoverEligibility(context, track, { ...status, playing: false }, true, key, null, true)).toEqual({ canEnter: false, canRemain: false });
  expect(idleCoverEligibility(context, track, status, false, key, null, true)).toEqual({ canEnter: false, canRemain: false });
  expect(idleCoverEligibility(context, track, status, true, key, null, false)).toEqual({ canEnter: true, canRemain: false });
});

it("keeps an existing cover while a new image or source cover is pending", () => {
  const context = idleCoverContext(track, status, cover, 4);
  expect(idleCoverEligibility(context, track, status, true, "old-key", null, true)).toEqual({ canEnter: false, canRemain: true });
  const pending = idleCoverContext(track, status, { ...cover, pending: true }, 4);
  expect(idleCoverEligibility(pending, track, status, true, "old-key", null, true)).toEqual({ canEnter: false, canRemain: true });
  const failed = idleCoverEligibility(context, track, status, true, null, context.key, true);
  expect(failed).toEqual({ canEnter: false, canRemain: false });
});

it("retains a cover during a switch but not after a failed mismatched load", () => {
  const switching = { ...status, path: "embedded:old", loading: true };
  const loadingContext = idleCoverContext(track, switching, cover, 4);
  expect(idleCoverEligibility(loadingContext, track, switching, true, null, null, true)).toEqual({ canEnter: false, canRemain: true });
  const failed = { ...switching, loading: false, load_error: "failed" };
  const failedContext = idleCoverContext(track, failed, cover, 4);
  expect(idleCoverEligibility(failedContext, track, failed, true, null, null, true)).toEqual({ canEnter: false, canRemain: true });
  // An already-resolved new image is still loading by key until the preload
  // reports failure, so explicitly failing that key ends retention.
  expect(idleCoverEligibility(failedContext, track, failed, true, null, failedContext.key, true)).toEqual({ canEnter: false, canRemain: false });
});
