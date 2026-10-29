import { importCustomAndWait, importExeAndWait, importSwfAndWait, partialImportCounts } from "./tauri";
import { importKindForPath, type ContainerImportOptions } from "./importFlow";

export interface MixedImportSummary {
  added: number;
  existing: number;
  failed: number;
  firstError: string | null;
}

type RunOwnedJob = <T>(path: string, run: (jobId: string) => Promise<T>) => Promise<T>;

/** Import one mixed selection sequentially, preserving completed results on failure. */
export async function importMixedFiles(
  paths: string[],
  options: ContainerImportOptions,
  runOwnedJob: RunOwnedJob,
  cancelled: () => boolean,
  audioErrorFallback: string,
): Promise<MixedImportSummary> {
  const summary: MixedImportSummary = { added: 0, existing: 0, failed: 0, firstError: null };
  for (const path of paths) {
    if (cancelled()) break;
    try {
      const kind = importKindForPath(path);
      if (kind === "audio") {
        const reports = await runOwnedJob(path, (jobId) => importCustomAndWait([path], jobId));
        summary.added += reports.filter((report) => report.added).length;
        summary.existing += reports.filter((report) => report.error === "already in library").length;
        const rejected = reports.find((report) => !report.added && report.error !== "already in library");
        if (rejected) {
          summary.failed++;
          summary.firstError ??= rejected.error ?? audioErrorFallback;
        }
      } else {
        const run = kind === "swf" ? importSwfAndWait : importExeAndWait;
        const report = await runOwnedJob(path, (jobId) => run(path, jobId, options.mode === "extract", options.copySource));
        summary.added += report.added;
        summary.existing += report.already_there;
        if (report.failed.length) {
          summary.failed++;
          summary.firstError ??= report.failed[0].reason;
        }
      }
    } catch (reason) {
      const partial = partialImportCounts(reason);
      summary.added += partial.added;
      summary.existing += partial.existing;
      if (!cancelled()) {
        summary.failed++;
        summary.firstError ??= String(reason);
      }
    }
  }
  return summary;
}
