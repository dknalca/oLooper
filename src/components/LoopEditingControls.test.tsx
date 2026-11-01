// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LoopEditingControls from "./LoopEditingControls";

afterEach(cleanup);
const actions = () => ({ onToggleLoop: vi.fn(), onDetect: vi.fn(), onStartChange: vi.fn(), onEndChange: vi.fn(), onApply: vi.fn() });
const base = { loaded: true, loopEnabled: true, durationMs: 1000, start: "100", end: "900", startRef: createRef<HTMLInputElement>(), endRef: createRef<HTMLInputElement>() };

it("forwards edits and operations while retaining the parent input refs", () => {
  const callbacks = actions();
  render(<LoopEditingControls {...base} {...callbacks} />);
  expect(base.startRef.current).toBe(screen.getByLabelText("Loop start in milliseconds"));
  expect(base.endRef.current).toBe(screen.getByLabelText("Loop end in milliseconds"));
  fireEvent.change(base.startRef.current!, { target: { value: "200" } });
  fireEvent.change(base.endRef.current!, { target: { value: "800" } });
  fireEvent.click(screen.getByRole("button", { name: "LOOP ON" }));
  fireEvent.click(screen.getByRole("button", { name: "AUTO" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(callbacks.onStartChange).toHaveBeenCalledWith("200");
  expect(callbacks.onEndChange).toHaveBeenCalledWith("800");
  expect(callbacks.onToggleLoop).toHaveBeenCalledOnce();
  expect(callbacks.onDetect).toHaveBeenCalledOnce();
  expect(callbacks.onApply).toHaveBeenCalledOnce();
});

it("disables edits and commands when no track is loaded", () => {
  render(<LoopEditingControls {...base} {...actions()} loaded={false} loopEnabled={false} />);
  expect((screen.getByRole("button", { name: "LOOP OFF" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Loop start in milliseconds") as HTMLInputElement).disabled).toBe(true);
});
