// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ImportBar from "./ImportBar";
import { ImportJobError, libraryLinkedFolders, librarySourceFolders, libraryRescanFolder, libraryLinkFolder, importLinkedFileAndWait, pickDirectory, pickFiles, scanLooperFolder, listenImportProgress, importCustomAndWait, importExeAndWait, importSwfAndWait, cancelImport, type LinkedFolder } from "../tauri";

const drag = vi.hoisted(() => ({ callback: null as null | ((event: { payload: { type: "drop"; paths: string[] } }) => void) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: (callback: typeof drag.callback) => { drag.callback = callback; return Promise.resolve(() => {}); } }) }));
vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  libraryLinkedFolders: vi.fn(), librarySourceFolders: vi.fn(), libraryRescanFolder: vi.fn(),
  libraryLinkFolder: vi.fn(), importLinkedFileAndWait: vi.fn(),
  pickDirectory: vi.fn(), pickFiles: vi.fn(), scanLooperFolder: vi.fn(),
  importCustomAndWait: vi.fn(), importExeAndWait: vi.fn(), importSwfAndWait: vi.fn(),
  cancelImport: vi.fn(),
  listenImportProgress: vi.fn().mockResolvedValue(() => {}),
}));

const folder: LinkedFolder = { id: 4, path: "/sources", extract_audio: true, copy_source: false, library_root: "/library-a" };
beforeEach(() => {
  localStorage.clear();
  drag.callback = null;
  vi.mocked(listenImportProgress).mockResolvedValue(() => {});
  vi.mocked(libraryLinkedFolders).mockResolvedValue([folder]);
  vi.mocked(librarySourceFolders).mockResolvedValue([folder]);
  vi.mocked(libraryLinkFolder).mockResolvedValue(folder);
});

it.each(["menu", "drop"] as const)("imports mixed selections through %s with shared options and partial errors", async (source) => {
  const paths = ["/sources/one.SWF", "/sources/two.exe", "/sources/three.wav"];
  vi.mocked(pickFiles).mockResolvedValue(paths);
  vi.mocked(importSwfAndWait).mockResolvedValue({ looper: "One", added: 1, already_there: 0, failed: [], track_ids: [1] });
  vi.mocked(importExeAndWait).mockRejectedValue(new ImportJobError({
    job_id: "job", stage: "complete", current: 1, total: 2, detail: "failed", done: true,
    error: "partial error", custom_report: null,
    report: { looper: "Two", added: 2, already_there: 1, failed: [], track_ids: [2, 3, 4] },
  }));
  vi.mocked(importCustomAndWait).mockResolvedValue([{ file: paths[2], added: true, track_id: 5, bpm: null, bpm_confidence: null, error: null }]);
  const refresh = vi.fn();
  render(<ImportBar onImported={refresh} />);
  await act(async () => {});
  if (source === "menu") {
    await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-files" })); });
  } else {
    expect(drag.callback).not.toBeNull();
    await act(async () => { drag.callback?.({ payload: { type: "drop", paths } }); });
  }
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Extract audio" })); });
  expect(importSwfAndWait).toHaveBeenCalledWith(paths[0], expect.any(String), true, true);
  expect(importExeAndWait).toHaveBeenCalledWith(paths[1], expect.any(String), true, true);
  expect(importCustomAndWait).toHaveBeenCalledWith([paths[2]], expect.any(String));
  expect(screen.getByText("+4")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("partial error");
  expect(refresh).toHaveBeenCalledOnce();
});

it.each(["menu", "drop"] as const)("cancels the owned job and retains partial tracks through %s", async (source) => {
  const paths = ["/sources/one.swf", "/sources/two.exe"];
  vi.mocked(pickFiles).mockResolvedValue(paths);
  vi.mocked(cancelImport).mockResolvedValue();
  let reject!: (reason: unknown) => void;
  vi.mocked(importSwfAndWait).mockReturnValue(new Promise((_, rejectJob) => { reject = rejectJob; }));
  const refresh = vi.fn();
  render(<ImportBar onImported={refresh} />);
  await act(async () => {});
  if (source === "menu") {
    await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-files" })); });
  } else {
    await act(async () => { drag.callback?.({ payload: { type: "drop", paths } }); });
  }
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play from source (no extraction)" })); });
  const jobId = vi.mocked(importSwfAndWait).mock.calls[0][1];
  if (!jobId) throw new Error("expected an owned import job ID");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "×" })); });
  expect(cancelImport).toHaveBeenCalledWith(jobId);
  await act(async () => { reject(new ImportJobError({
    job_id: jobId, stage: "complete", current: 1, total: 2, detail: "cancelled", done: true,
    error: "import cancelled", custom_report: null,
    report: { looper: "One", added: 1, already_there: 0, failed: [], track_ids: [1] },
  })); });
  expect(importExeAndWait).not.toHaveBeenCalled();
  expect(screen.getByText("+1")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
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

it("counts committed tracks when folder association fails after import", async () => {
  vi.mocked(libraryRescanFolder).mockResolvedValue({ folder, paths: ["/sources/new.swf"], removed: 0, unchanged: 0 });
  vi.mocked(importLinkedFileAndWait).mockRejectedValue(new ImportJobError({
    job_id: "job", stage: "complete", current: 2, total: 2, detail: "association failed", done: true,
    error: "Audio imported, but folder association failed", custom_report: null,
    report: { looper: "New", added: 2, already_there: 0, failed: [], track_ids: [1, 2] },
  }));
  const refresh = vi.fn();
  render(<ImportBar onImported={refresh} />);
  fireEvent.click(screen.getByRole("button", { name: "Folder" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toContain("2 added");
  expect(screen.getByRole("alert").textContent).toContain("folder association failed");
  expect(refresh).toHaveBeenCalled();
});

it("stops a folder rescan after a library change while reporting partial tracks", async () => {
  vi.mocked(libraryRescanFolder).mockResolvedValue({ folder, paths: ["/sources/one.swf", "/sources/two.swf"], removed: 0, unchanged: 1 });
  vi.mocked(importLinkedFileAndWait).mockRejectedValueOnce(new ImportJobError({
    job_id: "job", stage: "complete", current: 2, total: 3, detail: "failed", done: true,
    error: "Library changed during import", custom_report: null,
    report: { looper: "One", added: 2, already_there: 0, failed: [], track_ids: [1, 2] },
  }));
  render(<ImportBar onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Folder" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
  await act(async () => {});
  expect(importLinkedFileAndWait).toHaveBeenCalledExactlyOnceWith(folder, "/sources/one.swf", expect.any(String));
  expect(screen.getByRole("status").textContent).toContain("2 added");
  expect(screen.getByRole("alert").textContent).toContain("Library changed");
});

it("persists an empty imported folder so it can discover loopers on a later rescan", async () => {
  vi.mocked(pickDirectory).mockResolvedValue("/sources");
  vi.mocked(scanLooperFolder).mockResolvedValue([]);
  render(<ImportBar onImported={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-folder" })); });
  expect(libraryLinkFolder).toHaveBeenCalledWith("/sources", false, false);
  expect(importLinkedFileAndWait).not.toHaveBeenCalled();
});

it("opens the linked source folders requested from a looper or missing-audio prompt", async () => {
  render(<ImportBar onImported={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:rescan-source-folder", { detail: "source-hash" })); });
  expect(librarySourceFolders).toHaveBeenCalledWith("source-hash");
  expect(screen.getByRole("dialog").textContent).toContain("/sources");
});

it("focuses source playback by default and leaves source copying unchecked", async () => {
  vi.mocked(pickDirectory).mockResolvedValue("/sources");
  vi.mocked(scanLooperFolder).mockResolvedValue(["/sources/one.swf"]);
  vi.mocked(importLinkedFileAndWait).mockResolvedValue({ looper: "One", added: 1, already_there: 0, failed: [], track_ids: [1] });
  render(<ImportBar onImported={vi.fn()} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-folder" })); });
  const source = screen.getByRole("button", { name: "Play from source (no extraction)" });
  expect(document.activeElement).toBe(source);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await act(async () => { fireEvent.click(source); });
  expect(libraryLinkFolder).toHaveBeenCalledWith("/sources", false, false);
});

it("cancels the mode dialog with Escape, restores focus and permits a subsequent import", async () => {
  vi.mocked(pickFiles).mockResolvedValue(["/sources/one.swf"]);
  vi.mocked(importSwfAndWait).mockResolvedValue({ looper: "One", added: 1, already_there: 0, failed: [], track_ids: [1] });
  render(<><button>Previous focus</button><ImportBar onImported={vi.fn()} /></>);
  const browse = screen.getByRole("button", { name: "SWF / EXE" });
  const previous = screen.getByRole("button", { name: "Previous focus" });
  previous.focus();
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-loopers" })); });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await act(async () => {});
  expect(importSwfAndWait).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(previous);
  await act(async () => { fireEvent.click(browse); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play from source (no extraction)" })); });
  expect(importSwfAndWait).toHaveBeenCalledOnce();
});

it("retains partial folder imports and stops before using a changed library", async () => {
  vi.mocked(pickDirectory).mockResolvedValue("/sources");
  vi.mocked(scanLooperFolder).mockResolvedValue(["/sources/one.swf", "/sources/two.exe"]);
  vi.mocked(importLinkedFileAndWait).mockRejectedValueOnce(new ImportJobError({
    job_id: "job", stage: "complete", current: 2, total: 3, detail: "failed", done: true,
    error: "Library changed during import", custom_report: null,
    report: { looper: "One", added: 2, already_there: 0, failed: [], track_ids: [1, 2] },
  }));
  const refresh = vi.fn();
  render(<ImportBar onImported={refresh} />);
  await act(async () => { window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-folder" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play from source (no extraction)" })); });
  expect(importLinkedFileAndWait).toHaveBeenCalledExactlyOnceWith(folder, "/sources/one.swf", expect.any(String));
  expect(screen.getByText("+2")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("1 file(s) failed");
  expect(refresh).toHaveBeenCalledOnce();
});
