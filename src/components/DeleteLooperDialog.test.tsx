// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Track } from "../tauri";
import DeleteLooperDialog from "./DeleteLooperDialog";

afterEach(cleanup);

it("explains container and extracted audio removal for a mixed looper", () => {
  const cancel = vi.fn();
  const confirm = vi.fn();
  render(<DeleteLooperDialog name="Breaks" tracks={[
    { source_type: "swf", audio_storage: "embedded" } as Track,
    { source_type: "custom", audio_storage: "extracted" } as Track,
  ]} onCancel={cancel} onConfirm={confirm} />);
  expect(screen.getByRole("dialog", { name: "Delete looper “Breaks”?" })).toBeTruthy();
  expect(screen.getByText(/SWF\/EXE copy/)).toBeTruthy();
  expect(screen.getByText(/extracted or downloaded audio/)).toBeTruthy();
  expect(screen.getByText(/Original files outside the library will be kept/)).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete looper" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it("omits unrelated warnings and closes only when the backdrop is clicked", () => {
  const cancel = vi.fn();
  const view = render(<DeleteLooperDialog name="Remote" tracks={[{ source_type: "tablist", audio_storage: "embedded" } as Track]} onCancel={cancel} onConfirm={vi.fn()} />);
  expect(screen.queryByText(/SWF\/EXE copy/)).toBeNull();
  expect(screen.queryByText(/extracted or downloaded audio/)).toBeNull();
  fireEvent.mouseDown(screen.getByRole("dialog"));
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.mouseDown(view.container.firstChild!);
  expect(cancel).toHaveBeenCalledOnce();
});
