// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TablistCatalog from "./TablistCatalog";
import { importTablistAndWait, libraryTablistImportCounts, listenImportProgress, tablistSearch, type TablistCatalogLooper, type TablistCatalogPage } from "../tauri";

vi.mock("../tauri", async (original) => ({
  ...await original<typeof import("../tauri")>(),
  tablistSearch: vi.fn(), libraryTablistImportCounts: vi.fn(),
  listenImportProgress: vi.fn(), importTablistAndWait: vi.fn(), cancelImport: vi.fn(),
}));

const looper = (path: string, title: string): TablistCatalogLooper => ({
  nid: path, path, title, loops: ["one", "two"], tags: [], image: "", date: "",
});
const first = looper("loopers/complete", "Complete");
const second = looper("loopers/partial", "Partial");
const page: TablistCatalogPage = { hits: [first, second], estimatedTotalHits: 2, limit: 24, offset: 0, skippedInvalidPaths: 0 };
const props = { libraryReady: true, refreshKey: 0, onImported: vi.fn(), onLibraryViewChange: vi.fn() };

beforeEach(() => {
  vi.mocked(tablistSearch).mockResolvedValue(page);
  vi.mocked(libraryTablistImportCounts).mockResolvedValue([
    { source_path: "https://tablist.net/loopers/complete", tracks: 2 },
    { source_path: "/loopers/partial/", tracks: 1 },
  ]);
  vi.mocked(listenImportProgress).mockResolvedValue(() => {});
  vi.mocked(importTablistAndWait).mockResolvedValue([
    { file: "loop", added: true, track_id: 5, bpm: null, bpm_confidence: null, error: null },
  ]);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it("shows complete and partial results and random-imports an eligible looper", async () => {
  const imported = vi.fn();
  render(<TablistCatalog {...props} onImported={imported} />);
  await act(async () => {});
  const complete = screen.getByRole("button", { name: "Download all tracks from Complete" }) as HTMLButtonElement;
  const partial = screen.getByRole("button", { name: "Download all tracks from Partial" }) as HTMLButtonElement;
  expect(complete.disabled).toBe(true);
  expect(complete.textContent).toBe("Downloaded");
  expect(partial.textContent).toBe("Resume");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Descargar Random Looper" })); });
  expect(tablistSearch).toHaveBeenCalledWith("", 0, 1);
  expect(importTablistAndWait).toHaveBeenCalledExactlyOnceWith("https://tablist.net/loopers/partial", expect.any(String), null);
  expect(screen.getByRole("status").textContent).toContain("1 added");
  expect(imported).toHaveBeenCalledOnce();
});

it("does not allow a random import before a library is selected", async () => {
  render(<TablistCatalog {...props} libraryReady={false} />);
  await act(async () => {});
  expect((screen.getByRole("button", { name: "Descargar Random Looper" }) as HTMLButtonElement).disabled).toBe(true);
  expect(importTablistAndWait).not.toHaveBeenCalled();
});

it("does not import a complete looper when its row is double-clicked", async () => {
  render(<TablistCatalog {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.doubleClick(screen.getByRole("group", { name: "Complete, 2 loops" })); });
  expect(screen.getByRole("status").textContent).toContain("already fully downloaded");
  expect(importTablistAndWait).not.toHaveBeenCalled();
});

it("reports an empty random catalogue and re-enables the button", async () => {
  vi.mocked(tablistSearch).mockImplementation(async (_query, _offset, limit) =>
    limit === 1 ? { ...page, hits: [], estimatedTotalHits: 0 } : page);
  render(<TablistCatalog {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Descargar Random Looper" })); });
  expect(screen.getByRole("status").textContent).toContain("catalogue is empty");
  expect((screen.getByRole("button", { name: "Descargar Random Looper" }) as HTMLButtonElement).disabled).toBe(false);
  expect(importTablistAndWait).not.toHaveBeenCalled();
});

it("prevents another random search while one is pending", async () => {
  let finish!: (value: TablistCatalogPage) => void;
  vi.mocked(tablistSearch).mockImplementation(async (_query, _offset, limit) =>
    limit === 1 ? new Promise((resolve) => { finish = resolve; }) : page);
  render(<TablistCatalog {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Descargar Random Looper" })); });
  expect((screen.getByRole("button", { name: "Buscando looper…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish({ ...page, hits: [], estimatedTotalHits: 0 }); });
  expect((screen.getByRole("button", { name: "Descargar Random Looper" }) as HTMLButtonElement).disabled).toBe(false);
});
