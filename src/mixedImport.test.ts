import { beforeEach, expect, it, vi } from "vitest";
import { importMixedFiles } from "./mixedImport";
import { ImportJobError, importCustomAndWait, importExeAndWait, importSwfAndWait } from "./tauri";

vi.mock("./tauri", async (original) => ({
  ...await original<typeof import("./tauri")>(),
  importCustomAndWait: vi.fn(), importExeAndWait: vi.fn(), importSwfAndWait: vi.fn(),
}));

const options = { mode: "extract", copySource: true } as const;
const containerReport = { looper: "Loop", added: 2, already_there: 1, failed: [], track_ids: [1, 2, 3] };
const runOwned = <T,>(path: string, run: (jobId: string) => Promise<T>) => run(`job:${path}`);

beforeEach(() => vi.resetAllMocks());

it("imports mixed file types in order with the chosen container settings", async () => {
  const order: string[] = [];
  vi.mocked(importSwfAndWait).mockImplementation(async (path) => { order.push(path); return containerReport; });
  vi.mocked(importExeAndWait).mockImplementation(async (path) => { order.push(path); return { ...containerReport, added: 0, already_there: 0, failed: [{ id: 4, reason: "bad sound" }] }; });
  vi.mocked(importCustomAndWait).mockImplementation(async (paths) => {
    order.push(paths[0]);
    return [
      { file: paths[0], added: true, track_id: 4, bpm: null, bpm_confidence: null, error: null },
      { file: paths[0], added: false, track_id: 5, bpm: null, bpm_confidence: null, error: "already in library" },
    ];
  });
  const summary = await importMixedFiles(["/a.SWF", "/b.exe", "/c.wav"], options, runOwned, () => false, "audio import failed");
  expect(order).toEqual(["/a.SWF", "/b.exe", "/c.wav"]);
  expect(importSwfAndWait).toHaveBeenCalledWith("/a.SWF", "job:/a.SWF", true, true);
  expect(importExeAndWait).toHaveBeenCalledWith("/b.exe", "job:/b.exe", true, true);
  expect(importCustomAndWait).toHaveBeenCalledWith(["/c.wav"], "job:/c.wav");
  expect(summary).toEqual({ added: 3, existing: 2, failed: 1, firstError: "bad sound" });
});

it("retains partial counts and the first error while processing subsequent files", async () => {
  vi.mocked(importSwfAndWait).mockRejectedValue(new ImportJobError({
    job_id: "job", stage: "complete", current: 2, total: 3, detail: "failed", done: true,
    error: "decoder failed", report: containerReport, custom_report: null,
  }));
  vi.mocked(importCustomAndWait).mockResolvedValue([
    { file: "/b.wav", added: false, track_id: null, bpm: null, bpm_confidence: null, error: null },
  ]);
  const summary = await importMixedFiles(["/a.swf", "/b.wav"], options, runOwned, () => false, "audio import failed");
  expect(summary).toEqual({ added: 2, existing: 1, failed: 2, firstError: "ImportJobError: decoder failed (2 track(s) imported before failure)" });
});

it("does not start the next file until the current owned job finishes", async () => {
  let finish!: (report: typeof containerReport) => void;
  vi.mocked(importSwfAndWait).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  vi.mocked(importExeAndWait).mockResolvedValue(containerReport);
  const pending = importMixedFiles(["/a.swf", "/b.exe"], options, runOwned, () => false, "import failed");
  expect(importSwfAndWait).toHaveBeenCalledOnce();
  expect(importExeAndWait).not.toHaveBeenCalled();
  finish(containerReport);
  await pending;
  expect(importExeAndWait).toHaveBeenCalledOnce();
});

it("includes custom-audio partial results when an import job fails", async () => {
  vi.mocked(importCustomAndWait).mockRejectedValue(new ImportJobError({
    job_id: "job", stage: "complete", current: 2, total: 3, detail: "failed", done: true,
    error: "worker failed", report: null, custom_report: [
      { file: "/a.wav", added: true, track_id: 1, bpm: null, bpm_confidence: null, error: null },
      { file: "/b.wav", added: false, track_id: 2, bpm: null, bpm_confidence: null, error: "already in library" },
    ],
  }));
  const summary = await importMixedFiles(["/a.wav"], options, runOwned, () => false, "import failed");
  expect(summary.added).toBe(1);
  expect(summary.existing).toBe(1);
  expect(summary.failed).toBe(1);
  expect(summary.firstError).toContain("worker failed");
});

it("stops after cancellation but still counts results committed by the active job", async () => {
  let cancelled = false;
  vi.mocked(importSwfAndWait).mockImplementation(async () => {
    cancelled = true;
    throw new ImportJobError({
      job_id: "job", stage: "complete", current: 2, total: 3, detail: "cancelled", done: true,
      error: "import cancelled", report: containerReport, custom_report: null,
    });
  });
  const summary = await importMixedFiles(["/a.swf", "/b.exe"], options, runOwned, () => cancelled, "import failed");
  expect(summary).toEqual({ added: 2, existing: 1, failed: 0, firstError: null });
  expect(importExeAndWait).not.toHaveBeenCalled();
});

it("uses the caller's fallback for rejected audio without an error message", async () => {
  vi.mocked(importCustomAndWait).mockResolvedValue([
    { file: "/a.wav", added: false, track_id: null, bpm: null, bpm_confidence: null, error: null },
  ]);
  const summary = await importMixedFiles(["/a.wav"], options, runOwned, () => false, "import failed");
  expect(summary).toEqual({ added: 0, existing: 0, failed: 1, firstError: "import failed" });
});
