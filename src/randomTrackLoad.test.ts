// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRandomTrack } from "./randomTrackLoad";
import { libraryRandomTrack, playerCancelBoundaryLoad, playerLoadTrack, playerPlay, playerStatus, type PlayerStatus, type Track } from "./tauri";

vi.mock("./tauri", async (original) => ({
  ...await original<typeof import("./tauri")>(), libraryRandomTrack: vi.fn(), playerCancelBoundaryLoad: vi.fn(),
  playerLoadTrack: vi.fn(), playerPlay: vi.fn(), playerStatus: vi.fn(),
}));
const track = { id: 2, exists: true, playback_path: "track-2", source_hash: "pack" } as Track;
const status = { path: "track-2", loading: false, boundary_pending: false, load_error: null } as PlayerStatus;
const context = () => ({
  activeTrackId: 1, libraryGeneration: 3, libraryView: "local" as const, randomScopeHash: "pack",
  loadGeneration: { current: 0 }, candidate: { current: null }, onStatus: vi.fn(), onCommit: vi.fn(),
});
beforeEach(() => {
  vi.mocked(libraryRandomTrack).mockResolvedValue(track);
  vi.mocked(playerLoadTrack).mockResolvedValue(status);
  vi.mocked(playerPlay).mockResolvedValue(status);
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("loads a random track in scope and commits after playback starts", async () => {
  const ctx = context();
  await loadRandomTrack(ctx);
  expect(libraryRandomTrack).toHaveBeenCalledExactlyOnceWith(1, "pack");
  expect(playerLoadTrack).toHaveBeenCalledExactlyOnceWith(2);
  expect(playerPlay).toHaveBeenCalledOnce();
  expect(ctx.onCommit).toHaveBeenCalledExactlyOnceWith(track, status);
});

it("uses a matching prefetched candidate and commits a boundary switch without calling play", async () => {
  const ctx = { ...context(), candidate: { current: { track, key: "3|local|pack" } as { track: Track; key: string } | null } };
  await loadRandomTrack(ctx, { atLoopEnd: true });
  expect(libraryRandomTrack).not.toHaveBeenCalled();
  expect(ctx.candidate.current).toBeNull();
  expect(playerLoadTrack).toHaveBeenCalledExactlyOnceWith(2, true);
  expect(playerPlay).not.toHaveBeenCalled();
  expect(ctx.onCommit).toHaveBeenCalledExactlyOnceWith(track, status);
});

it("abandons a query cancelled before native loading starts", async () => {
  const ctx = context();
  const controller = new AbortController();
  let finish!: (track: Track) => void;
  vi.mocked(libraryRandomTrack).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = loadRandomTrack(ctx, { atLoopEnd: true, signal: controller.signal });
  controller.abort();
  finish(track);
  await pending;
  expect(playerLoadTrack).not.toHaveBeenCalled();
  expect(playerCancelBoundaryLoad).not.toHaveBeenCalled();
  expect(ctx.onCommit).not.toHaveBeenCalled();
});

it("does not load or commit a selection superseded while the query is pending", async () => {
  const ctx = context();
  let finish!: (track: Track) => void;
  vi.mocked(libraryRandomTrack).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = loadRandomTrack(ctx);
  ctx.loadGeneration.current++;
  finish(track);
  await pending;
  expect(playerLoadTrack).not.toHaveBeenCalled();
  expect(ctx.onStatus).not.toHaveBeenCalled();
  expect(ctx.onCommit).not.toHaveBeenCalled();
});

it("cancels an admitted boundary switch and does not commit a mismatched path", async () => {
  vi.useFakeTimers();
  const ctx = context();
  const controller = new AbortController();
  vi.mocked(playerLoadTrack).mockResolvedValue({ ...status, boundary_pending: true });
  vi.mocked(playerCancelBoundaryLoad).mockResolvedValue({ ...status, path: "old" });
  vi.mocked(playerStatus).mockResolvedValue({ ...status, path: "old" });
  const pending = loadRandomTrack(ctx, { atLoopEnd: true, signal: controller.signal });
  await vi.waitFor(() => expect(ctx.onStatus).toHaveBeenCalledOnce());
  controller.abort();
  await vi.advanceTimersByTimeAsync(150);
  expect(await pending).toBe(false);
  expect(playerCancelBoundaryLoad).toHaveBeenCalledOnce();
  expect(playerPlay).not.toHaveBeenCalled();
  expect(ctx.onCommit).not.toHaveBeenCalled();
});

it("never commits when a loaded path does not match the selected track", async () => {
  const ctx = context();
  vi.mocked(playerLoadTrack).mockResolvedValue({ ...status, path: "wrong" });
  expect(await loadRandomTrack(ctx)).toBe(false);
  expect(playerPlay).not.toHaveBeenCalled();
  expect(ctx.onCommit).not.toHaveBeenCalled();
});

it("cancels a boundary load that times out rather than committing it", async () => {
  vi.useFakeTimers();
  const ctx = context();
  const pendingStatus = { ...status, boundary_pending: true };
  vi.mocked(playerLoadTrack).mockResolvedValue(pendingStatus);
  vi.mocked(playerStatus).mockResolvedValue(pendingStatus);
  vi.mocked(playerCancelBoundaryLoad).mockResolvedValue(status);
  const result = expect(loadRandomTrack(ctx, { atLoopEnd: true })).rejects.toThrow("Random track load timed out");
  await vi.advanceTimersByTimeAsync(120_000);
  await result;
  expect(playerCancelBoundaryLoad).toHaveBeenCalledOnce();
  expect(ctx.onCommit).not.toHaveBeenCalled();
});
