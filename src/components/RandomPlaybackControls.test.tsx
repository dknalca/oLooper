// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RandomPlaybackControls from "./RandomPlaybackControls";

afterEach(cleanup);
const actions = () => ({ onToggle: vi.fn(), onIntervalChange: vi.fn(), onCustomMinutesChange: vi.fn() });
const base = { enabled: false, canRandom: true, validInterval: true, interval: "2" as const, customMinutes: "10", remaining: null };

it("forwards the toggle and interval selection", () => {
  const events = actions();
  render(<RandomPlaybackControls {...base} {...events} />);
  fireEvent.click(screen.getByRole("button", { name: "Random OFF" }));
  fireEvent.change(screen.getByLabelText("Random track interval"), { target: { value: "custom" } });
  expect(events.onToggle).toHaveBeenCalledOnce();
  expect(events.onIntervalChange).toHaveBeenCalledWith("custom");
});

it("shows custom input and countdown while allowing an invalid enabled timer to be turned off", () => {
  const events = actions();
  render(<RandomPlaybackControls {...base} {...events} enabled validInterval={false} interval="custom" remaining={65} />);
  fireEvent.change(screen.getByLabelText("Custom random interval in minutes"), { target: { value: "30" } });
  fireEvent.click(screen.getByRole("button", { name: "Random ON" }));
  expect(events.onCustomMinutesChange).toHaveBeenCalledWith("30");
  expect(events.onToggle).toHaveBeenCalledOnce();
  expect(screen.getByText("1:05")).toBeTruthy();
});

it("prevents enabling Random without tracks or with an invalid interval", () => {
  const view = render(<RandomPlaybackControls {...base} {...actions()} canRandom={false} />);
  expect((screen.getByRole("button", { name: "Random OFF" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<RandomPlaybackControls {...base} {...actions()} validInterval={false} />);
  expect((screen.getByRole("button", { name: "Random OFF" }) as HTMLButtonElement).disabled).toBe(true);
});
