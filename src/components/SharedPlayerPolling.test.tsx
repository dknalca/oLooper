// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Player from "./Player";
import { useAudioRoutingSession } from "../hooks/useAudioRoutingSession";
import { playerStatus, type PlayerStatus } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(), playerStatus: vi.fn(),
}));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const noop = () => {};
const pending = {
  loaded: false, playing: false, pitch_preparing: true, loading: false,
  generation: 1, path: null, duration_ms: 0, position_ms: 0, loop_start_ms: 0,
  loop_end_ms: 0, loop_enabled: true, volume_pct: 80, speed_pct: 100,
  output_left_level_pct: 0, output_right_level_pct: 0,
} as PlayerStatus;

function Consumers({ open, onStatus }: { open: boolean; onStatus: (status: PlayerStatus) => void }) {
  const resume = useRef(false);
  useAudioRoutingSession(open, false, resume, noop, noop, onStatus);
  return <Player status={pending} trackId={null} audioStorage="extracted" trackOpenGeneration={0}
    canRandom={false} onRandomTrack={async () => {}} canNavigateTracks={false}
    onPreviousTrack={noop} onNextTrack={noop} loopEditing={false} onToggleLoopEditing={noop}
    onStatusChange={onStatus} />;
}

it("Player and audio-session hooks use ten shared reads, then return to four when closed", async () => {
  vi.useFakeTimers();
  vi.mocked(playerStatus).mockResolvedValue(pending);
  const onStatus = vi.fn();
  const view = render(<Consumers open onStatus={onStatus} />);
  // Includes the separate one-shot read on opening and delayed Player startup.
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  vi.mocked(playerStatus).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(playerStatus).toHaveBeenCalledTimes(10);
  view.rerender(<Consumers open={false} onStatus={onStatus} />);
  vi.mocked(playerStatus).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(playerStatus).toHaveBeenCalledTimes(4);
  view.unmount();
  vi.mocked(playerStatus).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(playerStatus).not.toHaveBeenCalled();
});
