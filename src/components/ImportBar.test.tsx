// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ImportBar from "./ImportBar";
import { libraryLinkedFolders, librarySourceFolders, libraryRescanFolder, libraryLinkFolder, importLinkedFileAndWait, pickDirectory, scanLooperFolder, listenImportProgress, type LinkedFolder } from "../tauri";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }));
vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryLinkedFolders: vi.fn(), librarySourceFolders: vi.fn(), libraryRescanFolder: vi.fn(),
  libraryLinkFolder: vi.fn(), importLinkedFileAndWait: vi.fn(),
  pickDirectory: vi.fn(), scanLooperFolder: vi.fn(),
  listenImportProgress: vi.fn().mockResolvedValue(() => {}),
}));

const folder: LinkedFolder = { id: 4, path: "/sources", extract_audio: true, copy_source: false, library_root: "/library-a" };
beforeEach(() => {
  localStorage.clear();
  vi.mocked(listenImportProgress).mockResolvedValue(() => {});
  vi.mocked(libraryLinkedFolders).mockResolvedValue([folder]);
  vi.mocked(librarySourceFolders).mockResolvedValue([folder]);
  vi.mocked(libraryLinkFolder).mockResolvedValue(folder);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("rescans a remembered folder with captured library identity and imports only changed/new paths", async () => {
  vi.mocked(libraryRescanFolder).mockResolvedValue({ folder, paths: ["/sources/new.swf"], removed: 1, unchanged: 3 });
  vi.mocked(importLinkedFileAndWait).mockResolvedValue({ looper: "New", added: 2, already_there: 0, failed: [], track_ids: [1, 2] });
  const refresh = vi.fn();
  render(<ImportBar onImported={refresh} />);
  fireEvent.click(screen.getByRole("button", { name: "Folder" }));
  await act(async () => {});
  expect(screen.getByText("/sources")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
  await act(async () => {});
  expect(libraryRescanFolder).toHaveBeenCalledWith(folder);
  expect(importLinkedFileAndWait).toHaveBeenCalledWith(folder, "/sources/new.swf", expect.any(String));
  expect(screen.getByRole("status").textContent).toContain("2 added, 1 missing track(s) removed, 3 unchanged");
  expect(refresh).toHaveBeenCalled();
});

it("reports an unavailable folder without importing any files", async () => {
  vi.mocked(libraryRescanFolder).mockRejectedValue(new Error("Folder unavailable; nothing removed"));
  render(<ImportBar onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Folder" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("nothing removed");
  expect(importLinkedFileAndWait).not.toHaveBeenCalled();
});

it("persists an empty imported folder so it can discover loopers on a later rescan", async () => {
  vi.mocked(pickDirectory).mockResolvedValue("/sources");
  vi.mocked(scanLooperFolder).mockResolvedValue([]);
  render(<ImportBar onImported={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-folder" })); });
  expect(libraryLinkFolder).toHaveBeenCalledWith("/sources", true, false);
  expect(importLinkedFileAndWait).not.toHaveBeenCalled();
});

it("opens the linked source folders requested from a looper or missing-audio prompt", async () => {
  render(<ImportBar onImported={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:rescan-source-folder", { detail: "source-hash" })); });
  expect(librarySourceFolders).toHaveBeenCalledWith("source-hash");
  expect(screen.getByRole("dialog").textContent).toContain("/sources");
});
