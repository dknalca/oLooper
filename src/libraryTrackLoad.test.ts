import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitForLibraryTrack } from "./libraryTrackLoad";
import { playerLoadTrack, playerStatus, type PlayerStatus } from "./tauri";

vi.mock("./tauri", () => ({ playerLoadTrack: vi.fn(), playerStatus: vi.fn() }));
const ready = { loading: false, load_error: null, path: "embedded:1" } as PlayerStatus;
const loading = { ...ready, loading: true };
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it("returns an immediately loaded track only when it owns the expected playback path", async () => {
  vi.mocked(playerLoadTrack).mockResolvedValue(ready);
  await expect(waitForLibraryTrack(1, "embedded:1", () => true)).resolves.toEqual(ready);
  expect(playerLoadTrack).toHaveBeenCalledWith(1);
  expect(playerStatus).not.toHaveBeenCalled();
  await expect(waitForLibraryTrack(1, "embedded:other", () => true)).resolves.toBeNull();
});

it("polls until loading finishes and preserves the 150 ms interval", async () => {
  vi.mocked(playerLoadTrack).mockResolvedValue(loading);
  vi.mocked(playerStatus).mockResolvedValueOnce(loading).mockResolvedValueOnce(ready);
  const pending = waitForLibraryTrack(1, "embedded:1", () => true);
  await vi.advanceTimersByTimeAsync(149);
  expect(playerStatus).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(151);
  await expect(pending).resolves.toEqual(ready);
  expect(playerStatus).toHaveBeenCalledTimes(2);
});

it("stops applying a superseded load even if the status completed successfully", async () => {
  let current = true;
  vi.mocked(playerLoadTrack).mockResolvedValue(loading);
  vi.mocked(playerStatus).mockResolvedValue(ready);
  const pending = waitForLibraryTrack(1, "embedded:1", () => current);
  await vi.advanceTimersByTimeAsync(1);
  current = false;
  await vi.advanceTimersByTimeAsync(149);
  await expect(pending).resolves.toBeNull();
});

it("rejects load errors and times out if loading never finishes", async () => {
  vi.mocked(playerLoadTrack).mockResolvedValueOnce({ ...ready, load_error: "decode failed" }).mockResolvedValueOnce(loading);
  vi.mocked(playerStatus).mockResolvedValue(loading);
  await expect(waitForLibraryTrack(1, "embedded:1", () => true)).rejects.toThrow("decode failed");
  const pending = waitForLibraryTrack(1, "embedded:1", () => true);
  const assertion = expect(pending).rejects.toThrow("load timed out");
  await vi.advanceTimersByTimeAsync(120_000);
  await assertion;
});

it("ignores a stale result before treating a decoder error as current", async () => {
  vi.mocked(playerLoadTrack).mockResolvedValue({ ...ready, load_error: "stale error" });
  await expect(waitForLibraryTrack(1, "embedded:1", () => false)).resolves.toBeNull();
});
