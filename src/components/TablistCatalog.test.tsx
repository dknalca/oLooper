// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TablistCatalog from "./TablistCatalog";
import { cancelImport, importTablistAndWait, libraryTablistImportCounts, listenImportProgress, tablistSearch, type ImportProgress, type TablistCatalogLooper, type TablistCatalogPage } from "../tauri";

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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

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

it("keeps the latest catalog page when a previous page completes late", async () => {
  let finishOld!: (value: TablistCatalogPage) => void;
  const late = looper("loopers/late", "Late page");
  vi.mocked(tablistSearch).mockImplementation(async (_query, offset) => offset === 24
    ? new Promise((resolve) => { finishOld = resolve; })
    : { ...page, estimatedTotalHits: 50 });
  render(<TablistCatalog {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next catalog page" })); });
  // The next-page request is pending and pagination is disabled. Starting a
  // new search supersedes it once the debounce expires.
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Tablist loopers" }), { target: { value: "new query" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await act(async () => { finishOld({ ...page, hits: [late], estimatedTotalHits: 50 }); });
  expect(screen.queryByText("Late page")).toBeNull();
  expect(screen.getByText("Complete")).toBeTruthy();
  expect(tablistSearch).toHaveBeenCalledWith("new query", 0);
});

it("reuses recently visited public pages without a new native search, then expires them", async () => {
  vi.useFakeTimers();
  vi.mocked(tablistSearch).mockResolvedValue({ ...page, estimatedTotalHits: 50 });
  render(<TablistCatalog {...props} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next catalog page" })); });
  expect(tablistSearch).toHaveBeenCalledTimes(2);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Previous catalog page" })); });
  expect(tablistSearch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next catalog page" })); });
  expect(tablistSearch).toHaveBeenCalledTimes(3);
});

it("imports a partial looper when its download button is clicked", async () => {
  const imported = vi.fn();
  render(<TablistCatalog {...props} onImported={imported} />);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download all tracks from Partial" })); });
  expect(importTablistAndWait).toHaveBeenCalledExactlyOnceWith("https://tablist.net/loopers/partial", expect.any(String), null);
  expect(imported).toHaveBeenCalledOnce();
});

it("shows only its own job progress and cancels the active import", async () => {
  let receive!: (progress: ImportProgress) => void;
  let finish!: (value: Awaited<ReturnType<typeof importTablistAndWait>>) => void;
  const release = vi.fn();
  vi.mocked(listenImportProgress).mockImplementation(async (handler) => { receive = handler; return release; });
  vi.mocked(importTablistAndWait).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  vi.mocked(cancelImport).mockResolvedValue();
  const imported = vi.fn();
  const view = render(<TablistCatalog {...props} onImported={imported} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Download all tracks from Partial" }));
  const job = vi.mocked(importTablistAndWait).mock.calls[0][1];
  if (!job) throw new Error("expected an active import job");
  const progress: ImportProgress = { job_id: "other", stage: "foreign job", current: 1, total: 2, detail: "", done: false, error: null, report: null, custom_report: null };
  act(() => receive(progress));
  expect(screen.queryByText(/foreign job/)).toBeNull();
  act(() => receive({ ...progress, job_id: job, stage: "Downloading", detail: "loop 1" }));
  expect(screen.getByText(/Downloading 1\/2 · loop 1/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
  expect(cancelImport).toHaveBeenCalledExactlyOnceWith(job);
  await act(async () => { finish([{ file: "loop", added: true, track_id: 5, bpm: null, bpm_confidence: null, error: null }]); });
  expect(imported).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("does not apply old library download counts after a refresh", async () => {
  let finishOld!: (value: Awaited<ReturnType<typeof libraryTablistImportCounts>>) => void;
  vi.mocked(libraryTablistImportCounts).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce([{ source_path: "/loopers/partial/", tracks: 2 }]);
  const view = render(<TablistCatalog {...props} />);
  await act(async () => {});
  view.rerender(<TablistCatalog {...props} refreshKey={1} />);
  await act(async () => {});
  await act(async () => { finishOld([{ source_path: "/loopers/partial/", tracks: 1 }]); });
  const button = screen.getByRole("button", { name: "Download all tracks from Partial" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Downloaded");
});
