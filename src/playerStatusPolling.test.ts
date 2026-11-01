import { afterEach, expect, it, vi } from "vitest";
import { startPlayerStatusPolling } from "./playerStatusPolling";
import { playerStatus, type PlayerStatus } from "./tauri";

vi.mock("./tauri", () => ({ playerStatus: vi.fn() }));
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers(); vi.resetAllMocks();
});

it("shares native snapshots, including terminal decode, pitch and output errors", async () => {
  vi.useFakeTimers();
  const pending = { generation: 2, path: "embedded:1", loading: true, pitch_preparing: true } as PlayerStatus;
  const completed = { ...pending, loading: false, pitch_preparing: false, load_error: "decode failed", pitch_error: "stretch failed", output_error: "device removed" };
  vi.mocked(playerStatus).mockResolvedValueOnce(pending).mockResolvedValue(completed);
  const player = vi.fn();
  const meter = vi.fn();
  stops.push(startPlayerStatusPolling(() => player, 250, false));
  stops.push(startPlayerStatusPolling(() => meter, 100, false));
  await vi.advanceTimersByTimeAsync(250);
  expect(playerStatus).toHaveBeenCalledTimes(3); // 100, 200, first Player read 250.
  expect(player).toHaveBeenCalledExactlyOnceWith(completed);
  expect(meter).toHaveBeenLastCalledWith(completed);
  expect(player.mock.calls[0][0]).toBe(meter.mock.calls.at(-1)![0]);
});
