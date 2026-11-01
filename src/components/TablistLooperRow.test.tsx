// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TablistCatalogLooper } from "../tauri";
import TablistLooperRow from "./TablistLooperRow";

afterEach(cleanup);
const looper: TablistCatalogLooper = { nid: "1", path: "loopers/one", title: "One", loops: ["a", "b"], tags: ["scratch"], image: "", date: "" };
const base = { looper, counts: {}, libraryReady: true, activeLooper: null, randomLoading: false, progress: null };

it("handles row keyboard, double-click and context actions without duplicating button actions", () => {
  const onImport = vi.fn();
  const onContextMenu = vi.fn();
  render(<TablistLooperRow {...base} onImport={onImport} onContextMenu={onContextMenu} />);
  const row = screen.getByRole("group", { name: "One, 2 loops" });
  const button = screen.getByRole("button", { name: "Download all tracks from One" });
  fireEvent.keyDown(row, { key: "Enter" });
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.doubleClick(button);
  expect(onImport).toHaveBeenCalledOnce();
  fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
  expect(onContextMenu).toHaveBeenCalledWith(looper, 10, 20);
  fireEvent.click(button);
  fireEvent.doubleClick(row);
  expect(onImport).toHaveBeenCalledTimes(3);
});

it("presents partial, completed and busy states without enabling duplicate imports", () => {
  const view = render(<TablistLooperRow {...base} counts={{ "loopers/one": 1 }} onImport={vi.fn()} onContextMenu={vi.fn()} />);
  expect(screen.getByRole("button").textContent).toBe("Resume");
  view.rerender(<TablistLooperRow {...base} counts={{ "loopers/one": 2 }} onImport={vi.fn()} onContextMenu={vi.fn()} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button").textContent).toBe("Downloaded");
  view.rerender(<TablistLooperRow {...base} activeLooper="loopers/one" onImport={vi.fn()} onContextMenu={vi.fn()} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Preparing Tablist import")).toBeTruthy();
});
