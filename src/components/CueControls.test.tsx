// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CueControls from "./CueControls";

afterEach(cleanup);
const cue1 = { slot: 1, label: "Start", position_ms: 0 };
const cue2 = { slot: 2, label: "Cue", position_ms: 500 };
const callbacks = () => ({ onLoad: vi.fn(), onSave: vi.fn(), onClear: vi.fn(), onSync: vi.fn() });

it("loads and clears saved CUEs while saving empty slots and retaining fixed CUE 1", () => {
  const actions = callbacks();
  render(<CueControls {...actions} cues={[cue1, cue2]} ready audioStorage="extracted" activeCueSlot={2} syncing={false} />);
  fireEvent.click(screen.getByTitle("CUE 1 is fixed at the start of the track"));
  fireEvent.click(screen.getByTitle("Jump to CUE 2"));
  fireEvent.click(screen.getByTitle("Save CUE 3 at the current position"));
  fireEvent.click(screen.getByRole("button", { name: "Clear CUE 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Audio tags" }));
  expect(actions.onLoad.mock.calls).toEqual([[1], [2]]);
  expect(actions.onSave).toHaveBeenCalledWith(3);
  expect(actions.onClear).toHaveBeenCalledWith(2);
  expect(actions.onSync).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Clear CUE 1" })).toBeNull();
});

it("disables source-backed slots other than CUE 1 and hides Serato writes", () => {
  render(<CueControls {...callbacks()} cues={[cue1]} ready audioStorage="embedded" activeCueSlot={null} syncing={false} />);
  expect((screen.getByTitle("CUE 1 is fixed at the start of the track") as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getAllByTitle("Source-backed audio only has CUE 1").every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  expect(screen.queryByRole("button", { name: "Audio tags" })).toBeNull();
});

it("prevents slot and sync actions while metadata is not ready or a sync is running", () => {
  const actions = callbacks();
  const view = render(<CueControls {...actions} cues={[cue1]} ready={false} audioStorage="extracted" activeCueSlot={null} syncing={false} />);
  expect((screen.getByRole("button", { name: "Audio tags" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTitle("Save CUE 2 at the current position") as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<CueControls {...actions} cues={[cue1]} ready audioStorage="extracted" activeCueSlot={null} syncing />);
  expect((screen.getByRole("button", { name: "Sync…" }) as HTMLButtonElement).disabled).toBe(true);
});
