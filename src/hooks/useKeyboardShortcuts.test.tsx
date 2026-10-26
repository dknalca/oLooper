// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import useKeyboardShortcuts from "./useKeyboardShortcuts";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
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
