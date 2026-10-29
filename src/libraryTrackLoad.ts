import { playerLoadTrack, playerStatus, type PlayerStatus } from "./tauri";

/** Wait for a sidebar load to complete, or return null when superseded. */
export async function waitForLibraryTrack(
  trackId: number,
  playbackPath: string,
  isCurrent: () => boolean,
): Promise<PlayerStatus | null> {
  let status = await playerLoadTrack(trackId);
  const deadline = Date.now() + 120_000;
  while (status.loading && Date.now() < deadline) {
    if (!isCurrent()) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
    status = await playerStatus();
  }
  if (!isCurrent()) return null;
  if (status.loading) throw new Error("load timed out");
  if (status.load_error) throw new Error(status.load_error);
  return status.path === playbackPath ? status : null;
}
