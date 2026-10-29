import { partialImportCounts, type ImportReport } from "./tauri";

export interface ContainerImportSummary {
  added: number;
  existing: number;
  failedSounds: number;
  failures: string[];
  lastReport: ImportReport | null;
}

/** Keep the compact UI summary separate from the detailed progress error. */
export function containerImportMessages(summary: ContainerImportSummary, cancelled: boolean): { error: string | null; progressError: string | null } {
  const skipped = summary.failedSounds > 0 ? `${summary.failedSounds} embedded sound(s) skipped` : "";
  const error = [summary.failures.length > 0 ? `${summary.failures.length} file(s) failed` : "", skipped]
    .filter(Boolean).join("; ") || null;
  const progressError = summary.failures[0] ?? (skipped || (cancelled ? "import cancelled" : null));
  return { error, progressError };
}

/** Process container files in order, retaining partial results on errors. */
export async function importContainerFiles(
  paths: string[],
  importFile: (path: string) => Promise<ImportReport>,
  cancelled: () => boolean,
  stopOnLibraryChange: boolean,
): Promise<ContainerImportSummary> {
  const summary: ContainerImportSummary = { added: 0, existing: 0, failedSounds: 0, failures: [], lastReport: null };
  for (const path of paths) {
    if (cancelled()) break;
    try {
      const report = await importFile(path);
      summary.lastReport = report;
      summary.added += report.added;
      summary.existing += report.already_there;
      summary.failedSounds += report.failed.length;
    } catch (cause) {
      const partial = partialImportCounts(cause);
      summary.added += partial.added;
      summary.existing += partial.existing;
      summary.failedSounds += partial.failed;
      if (!cancelled()) summary.failures.push(`${path}: ${String(cause)}`);
      if (stopOnLibraryChange && String(cause).includes("Library changed")) break;
    }
  }
  return summary;
}

export interface RescanImportSummary {
  added: number;
  failed: number;
  errors: string[];
}

/** Rescan counts failed sounds on success, but failed files on job errors. */
export async function importRescannedFiles(
  paths: string[],
  importFile: (path: string) => Promise<ImportReport>,
  cancelled: () => boolean,
): Promise<RescanImportSummary> {
  const summary: RescanImportSummary = { added: 0, failed: 0, errors: [] };
  for (const path of paths) {
    if (cancelled()) break;
    try {
      const report = await importFile(path);
      summary.added += report.added;
      summary.failed += report.failed.length;
    } catch (cause) {
      summary.added += partialImportCounts(cause).added;
      if (!cancelled()) {
        summary.failed++;
        summary.errors.push(String(cause));
      }
      if (String(cause).includes("Library changed")) break;
    }
  }
  return summary;
}
