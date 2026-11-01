// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { executeMidiAction } from "./midiActions";
import { playerPause, playerPlay, playerSetVolume, playerStop, type MidiMessage, type PlayerStatus } from "./tauri";

vi.mock("./tauri", async (original) => ({
  ...await original<typeof import("./tauri")>(), playerPause: vi.fn(), playerPlay: vi.fn(), playerSetVolume: vi.fn(), playerStop: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const status = { loaded: true, playing: false, volume_pct: 98 } as PlayerStatus;
const context = () => ({ status, navigateLibrary: vi.fn(), navigateTrack: vi.fn(), playFirstTrack: vi.fn().mockResolvedValue(undefined), onStatus: vi.fn() });
const cc = (value: number): MidiMessage => ({ inputId: "midi", inputName: "MIDI", kind: "cc", channel: 0, number: 1, value });

it("routes encoder and library actions regardless of playback", () => {
  const ctx = { ...context(), status: null };
  executeMidiAction("library-encoder", cc(1), ctx);
  executeMidiAction("library-encoder", cc(127), ctx);
  executeMidiAction("library-encoder", cc(64), ctx);
  executeMidiAction("library-encoder", { ...cc(1), kind: "note" }, ctx);
  executeMidiAction("library-intro", undefined, ctx);
  executeMidiAction("library-back", undefined, ctx);
  expect(ctx.navigateLibrary.mock.calls).toEqual([["down"], ["up"], ["intro"], ["back"]]);
});

it("starts the first track if unloaded, clamps volume and forwards transport status", async () => {
  const ctx = context();
  vi.mocked(playerSetVolume).mockResolvedValue(status);
  vi.mocked(playerPlay).mockResolvedValue(status);
  vi.mocked(playerPause).mockResolvedValue(status);
  vi.mocked(playerStop).mockResolvedValue(status);
  executeMidiAction("play-pause", undefined, { ...ctx, status: null });
  executeMidiAction("volume-up", undefined, ctx);
  executeMidiAction("play-pause", undefined, ctx);
  executeMidiAction("play-pause", undefined, { ...ctx, status: { ...status, playing: true } });
  executeMidiAction("stop", undefined, ctx);
  executeMidiAction("next", undefined, ctx);
  await Promise.resolve();
  expect(ctx.playFirstTrack).toHaveBeenCalledOnce();
  expect(playerSetVolume).toHaveBeenCalledExactlyOnceWith(100);
  expect(playerPlay).toHaveBeenCalledOnce();
  expect(playerPause).toHaveBeenCalledOnce();
  expect(playerStop).toHaveBeenCalledOnce();
  expect(ctx.navigateTrack).toHaveBeenCalledExactlyOnceWith(1);
  expect(ctx.onStatus).toHaveBeenCalledTimes(4);
});

it("emits CUE shortcuts only for loaded playback and preserves random/metronome events", () => {
  const ctx = context();
  const cue = vi.fn(); const random = vi.fn(); const metronome = vi.fn();
  window.addEventListener("olooper:cue-shortcut", cue);
  window.addEventListener("olooper:random-loop", random);
  window.addEventListener("olooper:metronome-toggle", metronome);
  try {
    executeMidiAction("cue-2", undefined, { ...ctx, status: null });
    executeMidiAction("cue-2", undefined, ctx);
    executeMidiAction("clear-cue-3", undefined, ctx);
    executeMidiAction("random-loop", undefined, ctx);
    executeMidiAction("metronome-toggle", undefined, ctx);
    expect(cue.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([{ slot: 2, clear: false }, { slot: 3, clear: true }]);
    expect(random).toHaveBeenCalledOnce();
    expect(metronome).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("olooper:cue-shortcut", cue);
    window.removeEventListener("olooper:random-loop", random);
    window.removeEventListener("olooper:metronome-toggle", metronome);
  }
});
