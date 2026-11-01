export type RandomInterval = "2" | "5" | "custom";

interface Props {
  enabled: boolean;
  canRandom: boolean;
  validInterval: boolean;
  interval: RandomInterval;
  customMinutes: string;
  remaining: number | null;
  onToggle: () => void;
  onIntervalChange: (value: RandomInterval) => void;
  onCustomMinutesChange: (value: string) => void;
}

/** Controls only; Player owns the Random timer and playback lifecycle. */
export default function RandomPlaybackControls({ enabled, canRandom, validInterval, interval, customMinutes, remaining, onToggle, onIntervalChange, onCustomMinutesChange }: Props) {
  return <div className="flex items-center gap-1.5">
    <button onClick={onToggle} disabled={!canRandom || (!enabled && !validInterval)} aria-pressed={enabled}
      title="Change at the loop ending closest to this interval; manual Random remains immediate"
      className={`rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-30 ${enabled ? "bg-success/20 text-success" : "bg-border text-text-secondary hover:text-text"}`}>
      {enabled ? "Random ON" : "Random OFF"}
    </button>
    <select aria-label="Random track interval" value={interval} onChange={(event) => onIntervalChange(event.target.value as RandomInterval)}
      className="rounded border border-border bg-elevated px-1.5 py-1 text-[10px] text-text">
      <option value="2">2 min</option><option value="5">5 min</option><option value="custom">Custom</option>
    </select>
    {interval === "custom" && <input type="number" min={1} max={1440} step={1} value={customMinutes}
      onChange={(event) => onCustomMinutesChange(event.target.value)} aria-label="Custom random interval in minutes"
      className="w-12 rounded border border-border bg-elevated px-1.5 py-1 text-center text-[10px] text-text" />}
    {enabled && remaining !== null && <span className="min-w-8 font-mono text-[10px] tabular-nums text-success" aria-live="polite">
      {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
    </span>}
  </div>;
}
