// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useKeyboardShortcuts, { exposePlayerState } from "./useKeyboardShortcuts";
import { playerPlay, playerPause, playerSeek, playerSetLoopEnabled, playerStatus, playerStop, type PlayerStatus } from "../tauri";

vi.mock("../tauri", () => ({
  playerPlay: vi.fn(), playerPause: vi.fn(), playerSeek: vi.fn(),
  playerSetLoopEnabled: vi.fn(), playerStatus: vi.fn(), playerStop: vi.fn(),
}));

const base = { position_ms: 2_000, playing: false, loaded: true, loop_enabled: false, duration_ms: 10_000 } as PlayerStatus;
beforeEach(() => {
  vi.resetAllMocks();
  exposePlayerState(base);
  vi.mocked(playerPlay).mockResolvedValue({ ...base, playing: true });
  vi.mocked(playerPause).mockResolvedValue(base);
  vi.mocked(playerStop).mockResolvedValue(base);
  vi.mocked(playerSeek).mockResolvedValue(base);
  vi.mocked(playerSetLoopEnabled).mockResolvedValue({ ...base, loop_enabled: true });
  vi.mocked(playerStatus).mockResolvedValue(base);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function key(code: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...options });
  window.dispatchEvent(event);
  return event;
}

it("routes transport commands, clamps seeking and publishes returned status", async () => {
  const status = vi.fn();
  window.addEventListener("olooper:player-status", status);
  renderHook(() => useKeyboardShortcuts(false));
  await act(async () => { expect(key("Space").defaultPrevented).toBe(true); });
  expect(playerPlay).toHaveBeenCalledOnce();
  await act(async () => { key("Space"); });
  expect(playerPause).toHaveBeenCalledOnce();
  await act(async () => { key("ArrowLeft"); });
  expect(playerSeek).toHaveBeenLastCalledWith(0);
  await act(async () => { key("ArrowRight"); });
  expect(playerSeek).toHaveBeenLastCalledWith(7_000);
  await act(async () => { key("KeyL"); key("KeyS"); });
  expect(playerSetLoopEnabled).toHaveBeenCalledWith(true);
  expect(playerStop).toHaveBeenCalledOnce();
  expect(status).toHaveBeenCalledTimes(6);
  window.removeEventListener("olooper:player-status", status);
});

it("navigates the library unless shift requests seeking; disabled up/down stays untouched", async () => {
  const navigate = vi.fn();
  window.addEventListener("olooper:library-navigation", navigate);
  const hook = renderHook(({ enabled }) => useKeyboardShortcuts(enabled), { initialProps: { enabled: true } });
  key("ArrowLeft"); key("ArrowRight"); key("ArrowUp"); key("ArrowDown");
  expect(navigate.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual(["back", "intro", "up", "down"]);
  await act(async () => { key("ArrowRight", { shiftKey: true }); });
  expect(playerSeek).toHaveBeenCalledWith(7_000);
  hook.rerender({ enabled: false });
  expect(key("ArrowUp").defaultPrevented).toBe(false);
  expect(navigate).toHaveBeenCalledTimes(4);
  window.removeEventListener("olooper:library-navigation", navigate);
});

it("routes numbered cues, respects modifiers and leaves unrelated keys alone", () => {
  const cues = vi.fn();
  window.addEventListener("olooper:cue-shortcut", cues);
  renderHook(() => useKeyboardShortcuts());
  expect(key("Numpad3", { shiftKey: true }).defaultPrevented).toBe(true);
  expect((cues.mock.calls[0][0] as CustomEvent).detail).toEqual({ slot: 3, clear: true });
  expect(key("Digit1", { metaKey: true }).defaultPrevented).toBe(false);
  expect(key("KeyZ").defaultPrevented).toBe(false);
  expect(cues).toHaveBeenCalledOnce();
  window.removeEventListener("olooper:cue-shortcut", cues);
});

it("does not route shortcuts while a slider or tablist owns focus", () => {
  const listener = vi.fn();
  window.addEventListener("olooper:random-loop", listener);
  renderHook(() => useKeyboardShortcuts());
  const slider = document.createElement("div");
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  document.body.append(slider);
  slider.focus();
  key("KeyR");
  slider.remove();
  const tabs = document.createElement("div");
  tabs.setAttribute("role", "tablist");
  const child = document.createElement("button");
  tabs.append(child);
  document.body.append(tabs);
  child.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true }));
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener("olooper:random-loop", listener);
});

it("refreshes state after a failed transport command and continues processing", async () => {
  vi.mocked(playerPlay).mockRejectedValueOnce(new Error("unavailable"));
  renderHook(() => useKeyboardShortcuts());
  await act(async () => { key("Space"); });
  expect(playerStatus).toHaveBeenCalledOnce();
  await act(async () => { key("Space"); });
  expect(playerPlay).toHaveBeenCalledTimes(2);
});

it("keeps transport commands serialized while a previous command is pending", async () => {
  let finish!: (status: PlayerStatus) => void;
  vi.mocked(playerPlay).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  renderHook(() => useKeyboardShortcuts());
  await act(async () => { key("Space"); key("KeyS"); });
  expect(playerPlay).toHaveBeenCalledOnce();
  expect(playerStop).not.toHaveBeenCalled();
  await act(async () => { finish({ ...base, playing: true }); });
  expect(playerStop).toHaveBeenCalledOnce();
});

it("does not invoke transport on an unloaded player and clamps the upper seek boundary", async () => {
  exposePlayerState({ ...base, loaded: false });
  renderHook(() => useKeyboardShortcuts(false));
  await act(async () => { key("Space"); key("KeyS"); key("KeyL"); key("ArrowRight"); });
  expect(playerPlay).not.toHaveBeenCalled();
  expect(playerStop).not.toHaveBeenCalled();
  expect(playerSetLoopEnabled).not.toHaveBeenCalled();
  expect(playerSeek).not.toHaveBeenCalled();
  exposePlayerState({ ...base, position_ms: 9_500 });
  await act(async () => { key("ArrowRight"); });
  expect(playerSeek).toHaveBeenCalledWith(10_000);
});

it("R triggers the shared random action used by the button and MIDI", () => {
  const listener = vi.fn();
  window.addEventListener("olooper:random-loop", listener);
  renderHook(() => useKeyboardShortcuts(true));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true }));
  expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener("olooper:random-loop", listener);
});

it("R stays silent while typing or with a modal dialog open", () => {
  const listener = vi.fn();
  window.addEventListener("olooper:random-loop", listener);
  renderHook(() => useKeyboardShortcuts(true));
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true }));
  expect(listener).not.toHaveBeenCalled();
  input.remove();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true }));
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener("olooper:random-loop", listener);
});
