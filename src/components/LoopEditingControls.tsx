import type { RefObject } from "react";

interface Props {
  loaded: boolean;
  loopEnabled: boolean;
  durationMs: number;
  start: string;
  end: string;
  startRef: RefObject<HTMLInputElement>;
  endRef: RefObject<HTMLInputElement>;
  onToggleLoop: () => void;
  onDetect: () => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onApply: () => void;
}

/** Loop editor view; Player keeps input state, analysis and native commands. */
export default function LoopEditingControls({ loaded, loopEnabled, durationMs, start, end, startRef, endRef, onToggleLoop, onDetect, onStartChange, onEndChange, onApply }: Props) {
  return <div id="loop-edit-controls" className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
    <button onClick={onToggleLoop} disabled={!loaded} aria-pressed={loopEnabled}
      className={`rounded px-2 py-1 text-[10px] font-medium disabled:opacity-40 ${loopEnabled ? "bg-success/20 text-success" : "bg-border text-text-secondary hover:text-text"}`}>
      {loopEnabled ? "LOOP ON" : "LOOP OFF"}
    </button>
    <button onClick={onDetect} disabled={!loaded} className="rounded bg-border px-2 py-1 text-[10px] text-text-secondary hover:text-text disabled:opacity-40">AUTO</button>
    <label className="flex items-center gap-1 text-[10px] text-text-secondary">Start
      <input ref={startRef} type="number" min={0} max={durationMs} value={start} onChange={(event) => onStartChange(event.target.value)}
        disabled={!loaded} aria-label="Loop start in milliseconds" className="w-20 rounded border border-border bg-elevated px-1.5 py-1 text-center font-mono text-text disabled:opacity-40" /> ms
    </label>
    <span className="text-[10px] text-text-secondary">–</span>
    <label className="flex items-center gap-1 text-[10px] text-text-secondary">End
      <input ref={endRef} type="number" min={0} max={durationMs} value={end} onChange={(event) => onEndChange(event.target.value)}
        disabled={!loaded} aria-label="Loop end in milliseconds" className="w-20 rounded border border-border bg-elevated px-1.5 py-1 text-center font-mono text-text disabled:opacity-40" /> ms
    </label>
    <button onClick={onApply} disabled={!loaded} className="rounded bg-accent/15 px-2.5 py-1 text-[10px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40">Apply</button>
    <span className="text-[10px] text-text-secondary">Drag a loop edge on the waveform to adjust it.</span>
  </div>;
}
