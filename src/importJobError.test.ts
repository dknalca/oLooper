import { expect, it } from "vitest";
import { ImportJobError, partialImportCounts, type ImportProgress } from "./tauri";

it("retains partial report IDs and counts instead of losing completed tracks", () => {
  const progress: ImportProgress = {
    job_id: "test", stage: "complete", current: 3, total: 10, detail: "cancelled", done: true, error: "import cancelled",
    report: { looper: "Example", added: 2, already_there: 1, failed: [], track_ids: [10, 11, 12] }, custom_report: null,
  };
  const error = new ImportJobError(progress);
  expect(error.report?.track_ids).toEqual([10, 11, 12]);
  expect(partialImportCounts(error)).toEqual({ added: 2, existing: 1, failed: 0 });
  expect(error.message).toContain("2 track(s)");
});
