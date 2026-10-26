// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import useModalFocus from "./useModalFocus";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Fixture({ open, close }: { open: boolean; close: () => void }) {
  useModalFocus();
  return <><button>Background</button>{open && <section role="dialog" aria-modal="true">
    <button>First</button><button className="dialog-close" onClick={close}>Close</button>
  </section>}</>;
}
function InitialFocusFixture() {
  useModalFocus();
  return <section role="dialog" aria-modal="true"><input aria-label="Title" /><input data-dialog-initial-focus="" aria-label="BPM" /></section>;
}
it("honors the dialog's declared initial focus without a competing autofocus timer", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  render(<InitialFocusFixture />);
  await act(async () => {});
  expect(document.activeElement).toBe(screen.getByLabelText("BPM"));
});
it("traps focus, handles Escape and restores the previous control", async () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  const close = vi.fn();
  const view = render(<Fixture open={false} close={close} />);
  screen.getByText("Background").focus();
  await act(async () => { view.rerender(<Fixture open close={close} />); });
  expect(document.activeElement).toBe(screen.getByText("First"));
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText("Close"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { view.rerender(<Fixture open={false} close={close} />); });
  expect(document.activeElement).toBe(screen.getByText("Background"));
});
