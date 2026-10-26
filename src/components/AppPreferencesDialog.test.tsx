// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import AppPreferencesDialog from "./AppPreferencesDialog";

afterEach(() => cleanup());

it("offers a persisted minute-based delay selector alongside the cover toggle", () => {
  const onDelay = vi.fn();
  render(<AppPreferencesDialog open idleCoverEnabled idleCoverDelayMinutes={5} error={null} onIdleCoverChange={vi.fn()} onIdleCoverDelayChange={onDelay} onClose={vi.fn()} />);
  expect(screen.getByRole("checkbox", { name: "Show looper cover after inactivity" })).toBeTruthy();
  const delay = screen.getByRole("combobox", { name: "Looper cover wait time in minutes" }) as HTMLSelectElement;
  expect(delay.value).toBe("5");
  expect(Array.from(delay.options).map((option) => option.value)).toEqual(["1", "2", "3", "5", "10", "15", "20", "30", "45", "60"]);
  fireEvent.change(delay, { target: { value: "15" } });
  expect(onDelay).toHaveBeenCalledWith(15);
});

it("disables the delay selector while the looper-cover feature is off", () => {
  render(<AppPreferencesDialog open idleCoverEnabled={false} idleCoverDelayMinutes={5} error={null} onIdleCoverChange={vi.fn()} onIdleCoverDelayChange={vi.fn()} onClose={vi.fn()} />);
  expect((screen.getByRole("combobox", { name: "Looper cover wait time in minutes" }) as HTMLSelectElement).disabled).toBe(true);
});
