import type { Track } from "../tauri";

interface Props {
  name: string;
  tracks: Track[];
  onCancel: () => void;
  onConfirm: () => void;
}

/** Explain the assets affected by a group removal; the parent owns deletion. */
export default function DeleteLooperDialog({ name, tracks, onCancel, onConfirm }: Props) {
  const hasImportedContainer = tracks.some((track) => track.source_type === "swf" || track.source_type === "exe");
  const hasStoredAudio = tracks.some((track) => track.audio_storage === "extracted");
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="delete-looper-title" aria-describedby="delete-looper-description" className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-2xl">
      <h2 id="delete-looper-title" className="text-sm font-semibold text-text">Delete looper “{name}”?</h2>
      <div id="delete-looper-description" className="mt-3 space-y-2 text-xs leading-relaxed text-text-secondary">
        {hasImportedContainer && <p>The imported SWF/EXE copy in the library will be deleted when no other tracks use it.</p>}
        {hasStoredAudio && <p>All extracted or downloaded audio files for this looper will be deleted.</p>}
        <p>The library cover will also be deleted. Original files outside the library will be kept.</p>
        <p>This cannot be undone. Confirm to continue.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button autoFocus onClick={onCancel} className="dialog-close">Cancel</button>
        <button onClick={onConfirm} className="rounded bg-danger px-3 py-2 text-xs font-medium text-white hover:bg-danger/85">Delete looper</button>
      </div>
    </section>
  </div>;
}
