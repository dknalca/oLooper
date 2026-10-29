import { expect, it, vi } from "vitest";
import { containerImportMessages, importContainerFiles, importRescannedFiles } from "./containerImport";
import { ImportJobError, type ImportReport } from "./tauri";

const report: ImportReport = {
  looper: "One", added: 2, already_there: 1, failed: [{ id: 8, reason: "bad sound" }], track_ids: [1, 2, 3],
};
function partialFailure(error: string) {
  return new ImportJobError({
    job_id: "job", stage: "complete", current: 3, total: 4, detail: error, done: true,
    error, report, custom_report: null,
  });
}

it.each([
  { failures: [], failedSounds: 0, cancelled: false, error: null, progressError: null },
  { failures: [], failedSounds: 0, cancelled: true, error: null, progressError: "import cancelled" },
  { failures: [], failedSounds: 2, cancelled: true, error: "2 embedded sound(s) skipped", progressError: "2 embedded sound(s) skipped" },
  { failures: ["first failure", "second failure"], failedSounds: 2, cancelled: true, error: "2 file(s) failed; 2 embedded sound(s) skipped", progressError: "first failure" },
])("keeps import summary and progress precedence (failures=$failures, skipped=$failedSounds, cancelled=$cancelled)", ({ failures, failedSounds, cancelled, error, progressError }) => {
  const summary = { added: 0, existing: 0, failedSounds, failures, lastReport: null };
  expect(containerImportMessages(summary, cancelled)).toEqual({ error, progressError });
});

it("processes files sequentially and accumulates successful and partial reports", async () => {
  let finish!: (value: ImportReport) => void;
  const importFile = vi.fn()
    .mockImplementationOnce(() => new Promise<ImportReport>((resolve) => { finish = resolve; }))
    .mockRejectedValueOnce(partialFailure("decoder failed"))
    .mockResolvedValueOnce({ ...report, looper: "Last", added: 1, already_there: 0, failed: [] });
  const pending = importContainerFiles(["one.swf", "two.exe", "three.swf"], importFile, () => false, false);
  expect(importFile).toHaveBeenCalledTimes(1);
  finish(report);
  const summary = await pending;
  expect(importFile.mock.calls.map(([path]) => path)).toEqual(["one.swf", "two.exe", "three.swf"]);
  expect(summary.added).toBe(5);
  expect(summary.existing).toBe(2);
  expect(summary.failedSounds).toBe(2);
  expect(summary.failures).toHaveLength(1);
  expect(summary.failures[0]).toContain("two.exe: ImportJobError: decoder failed");
  expect(summary.lastReport?.looper).toBe("Last");
});

it("retains completed partial counts on cancellation without reporting the job as failed", async () => {
  let cancelled = false;
  const importFile = vi.fn(async () => { cancelled = true; throw partialFailure("import cancelled"); });
  const summary = await importContainerFiles(["one.swf", "two.swf"], importFile, () => cancelled, true);
  expect(importFile).toHaveBeenCalledOnce();
  expect(summary).toEqual({ added: 2, existing: 1, failedSounds: 1, failures: [], lastReport: null });
});

it.each([true, false])("stops on a library change only when linked=%s", async (linked) => {
  const importFile = vi.fn().mockRejectedValueOnce(new Error("Library changed during import")).mockResolvedValue(report);
  const summary = await importContainerFiles(["one.swf", "two.swf"], importFile, () => false, linked);
  expect(importFile).toHaveBeenCalledTimes(linked ? 1 : 2);
  expect(summary.failures).toEqual(["one.swf: Error: Library changed during import"]);
  expect(summary.lastReport).toEqual(linked ? null : report);
});

it("skips all work if already cancelled", async () => {
  const importFile = vi.fn();
  expect(await importContainerFiles(["one.swf"], importFile, () => true, true)).toEqual({
    added: 0, existing: 0, failedSounds: 0, failures: [], lastReport: null,
  });
  expect(importFile).not.toHaveBeenCalled();
});

it("rescans in order and distinguishes failed sounds from failed jobs", async () => {
  const importFile = vi.fn().mockResolvedValueOnce(report).mockRejectedValueOnce(partialFailure("decoder failed")).mockResolvedValueOnce(report);
  const summary = await importRescannedFiles(["one.swf", "two.swf", "three.swf"], importFile, () => false);
  expect(importFile.mock.calls.map(([path]) => path)).toEqual(["one.swf", "two.swf", "three.swf"]);
  expect(summary.added).toBe(6);
  // Two failed sounds in successful reports plus one failed job; the failed
  // sounds in a partial error report are not counted again by this UI flow.
  expect(summary.failed).toBe(3);
  expect(summary.errors[0]).toContain("decoder failed");
});

it("stops a rescan on a library change after preserving partial additions", async () => {
  const importFile = vi.fn().mockRejectedValueOnce(partialFailure("Library changed during import"));
  const summary = await importRescannedFiles(["one.swf", "two.swf"], importFile, () => false);
  expect(importFile).toHaveBeenCalledOnce();
  expect(summary.added).toBe(2);
  expect(summary.failed).toBe(1);
  expect(summary.errors[0]).toContain("Library changed");
});

it("does not turn rescan cancellation into a failed job", async () => {
  let cancelled = false;
  const importFile = vi.fn(async () => { cancelled = true; throw partialFailure("import cancelled"); });
  const summary = await importRescannedFiles(["one.swf", "two.swf"], importFile, () => cancelled);
  expect(importFile).toHaveBeenCalledOnce();
  expect(summary).toEqual({ added: 2, failed: 0, errors: [] });
});
