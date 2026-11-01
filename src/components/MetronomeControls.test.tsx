// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MetronomeControls from "./MetronomeControls";
import { playerSetMetronome, type PlayerStatus } from "../tauri";

vi.mock("../tauri", async (original) => ({ ...await original<typeof import("../tauri")>(), playerSetMetronome: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.mocked(playerSetMetronome).mockResolvedValue({} as PlayerStatus); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it("starts from the track BPM, advances beats and follows a new track", async () => {
  const view = render(<MetronomeControls trackBpm={100} />);
  fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
  expect(playerSetMetronome).toHaveBeenCalledWith(true, 100);
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Metronome beat 1 of 4");
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Metronome beat 2 of 4");
  view.rerender(<MetronomeControls trackBpm={140} />);
  await act(async () => {});
  expect(playerSetMetronome).toHaveBeenLastCalledWith(true, 140);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("140");
});

it("rejects invalid tempo and removes the MIDI event listener on unmount", async () => {
  const view = render(<MetronomeControls trackBpm={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "10" } });
  await act(async () => { window.dispatchEvent(new Event("olooper:metronome-toggle")); });
  expect(screen.getByRole("alert").textContent).toContain("between 30 and 300");
  expect(playerSetMetronome).not.toHaveBeenCalled();
  view.unmount();
  window.dispatchEvent(new Event("olooper:metronome-toggle"));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(playerSetMetronome).not.toHaveBeenCalled();
});

it("surfaces a native command failure without starting", async () => {
  vi.mocked(playerSetMetronome).mockRejectedValueOnce(new Error("audio unavailable"));
  render(<MetronomeControls trackBpm={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Metronome settings" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start" })); });
  expect(screen.getByRole("alert").textContent).toContain("audio unavailable");
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
});
