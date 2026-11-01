interface Props {
  levels: { left: number; right: number };
  testChannel: "left" | "right" | null;
}

/** Digital signal levels and test feedback, not a hardware loopback meter. */
export default function AudioOutputMeter({ levels, testChannel }: Props) {
  return <>
    <div className="mt-3 space-y-1.5" aria-label="Digital output levels">
      {([ ["L", levels.left], ["R", levels.right] ] as const).map(([channel, level]) => {
        const percent = Math.max(0, Math.min(100, level));
        return <div key={channel} className="grid grid-cols-[1rem_1fr_2.5rem] items-center gap-2 text-[10px]">
          <span className="font-mono text-text-secondary">{channel}</span>
          <div role="meter" aria-label={`${channel} digital output level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="h-2 overflow-hidden rounded bg-border">
            <div className="h-full rounded bg-accent transition-[width] duration-75" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-right tabular-nums text-text-secondary">{Math.round(percent)}%</span>
        </div>;
      })}
    </div>
    <p className="mt-1 text-[9px] text-text-secondary">Digital signal sent by oLooper before the audio interface; this is not a hardware loopback meter.</p>
    {testChannel && <div className="mt-3 flex items-center gap-2 rounded border border-border bg-elevated px-3 py-2 text-[10px]" role="status" aria-live="polite">
      <span className={`h-2 w-2 rounded-full ${testChannel === "left" ? "bg-accent" : "bg-border"}`} />
      <span className="text-text-secondary">L</span>
      <span className={`h-2 w-2 rounded-full ${testChannel === "right" ? "bg-accent" : "bg-border"}`} />
      <span className="text-text-secondary">R</span>
      <span className="ml-1 text-text">Testing {testChannel === "left" ? "left" : "right"} channel…</span>
    </div>}
  </>;
}
