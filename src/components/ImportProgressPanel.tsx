import { elapsedLabel, fileName } from "../importFlow";
import type { ImportFileState } from "../hooks/useImportJobs";
import type { ImportProgress } from "../tauri";

interface Props {
  progress: ImportProgress | null;
  files: ImportFileState[];
  elapsed: number;
  onDismiss: () => void;
}

/** Detailed progress view; job ownership and cancellation remain in useImportJobs. */
export default function ImportProgressPanel({ progress, files, elapsed, onDismiss }: Props) {
  if (!progress || files.length === 0) return null;
  return <div className="fixed right-3 top-12 z-[80] w-[min(28rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-surface px-4 py-2 shadow-xl">
    <div className="flex items-center justify-between mb-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-text-secondary">Importing</span>
        {progress.total > 0 && <div className="w-24 h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }} />
        </div>}
        {progress.total > 0 && <span className="text-[10px] text-text-secondary">{Math.round((progress.current / progress.total) * 100)}%</span>}
        <span className="font-mono text-[10px] text-text-secondary">{elapsedLabel(elapsed)}</span>
      </div>
      <div className="flex items-center gap-2">
        {progress.error && <span className="text-[10px] text-danger">{progress.error}</span>}
        {progress.done && <button onClick={onDismiss} className="text-[10px] text-text-secondary hover:text-text transition-colors">Dismiss</button>}
      </div>
    </div>
    <div className="max-h-24 overflow-y-auto rounded border border-border/30">
      {files.map((file) => <div key={file.path} className="flex items-center gap-2 border-b border-border/20 px-2 py-1 text-[10px] last:border-b-0">
        <span className={`h-1 w-1 rounded-full shrink-0 ${file.error ? "bg-danger" : file.done ? "bg-success" : "bg-accent"}`} />
        <span className="min-w-0 flex-1 truncate text-text" title={file.path}>{fileName(file.path)}</span>
        <span className="shrink-0 text-text-secondary">{file.error ?? file.stage}</span>
      </div>)}
    </div>
  </div>;
}
