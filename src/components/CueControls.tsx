import type { SeratoCue } from "../tauri";

const CUE_SLOTS = [1, 2, 3, 4];

interface Props {
  cues: SeratoCue[];
  ready: boolean;
  audioStorage: "extracted" | "embedded";
  activeCueSlot: number | null;
  syncing: boolean;
  onLoad: (slot: number) => void;
  onSave: (slot: number) => void;
  onClear: (slot: number) => void;
  onSync: () => void;
}

/** Render fixed CUE slots; mutations and ownership checks remain in Player. */
export default function CueControls({ cues, ready, audioStorage, activeCueSlot, syncing, onLoad, onSave, onClear, onSync }: Props) {
  return <div className="flex items-center gap-1">
    <span className="mr-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">CUE</span>
    {CUE_SLOTS.map((slot) => {
      const cue = cues.find((saved) => saved.slot === slot);
      return <span key={slot} className="flex items-center">
        <button
          onClick={() => cue ? onLoad(slot) : onSave(slot)}
          disabled={!ready || (audioStorage === "embedded" && slot !== 1)}
          title={slot === 1 ? "CUE 1 is fixed at the start of the track" : audioStorage === "embedded" ? "Source-backed audio only has CUE 1" : cue ? `Jump to CUE ${slot}` : `Save CUE ${slot} at the current position`}
          className={`w-6 h-6 rounded text-[10px] font-bold transition-colors disabled:opacity-40 ${activeCueSlot === slot ? "bg-accent text-app" : cue ? "bg-success/20 text-success hover:bg-success/30" : "bg-border text-text-secondary hover:bg-border hover:text-text"}`}
        >{slot}</button>
        {cue && slot > 1 && <button onClick={() => onClear(slot)} title={`Clear CUE ${slot}`} aria-label={`Clear CUE ${slot}`} className="-ml-1 rounded px-1 text-[10px] text-text-secondary hover:bg-danger/10 hover:text-danger">×</button>}
      </span>;
    })}
    {audioStorage === "extracted" && <button onClick={onSync} disabled={!ready || syncing}
      title="Write CUEs and BPM into this audio file"
      className="ml-1 rounded bg-accent/15 px-2 py-1 text-[9px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
    >{syncing ? "Sync…" : "Audio tags"}</button>}
  </div>;
}
