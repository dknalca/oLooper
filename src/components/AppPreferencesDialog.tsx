import { IDLE_COVER_DELAY_OPTIONS_MINUTES } from "../appPreferences";

interface Props {
  open: boolean;
  idleCoverEnabled: boolean;
  idleCoverDelayMinutes: number;
  error: string | null;
  onIdleCoverChange: (enabled: boolean) => void;
  onIdleCoverDelayChange: (minutes: number) => void;
  onClose: () => void;
}

export default function AppPreferencesDialog({ open, idleCoverEnabled, idleCoverDelayMinutes, error, onIdleCoverChange, onIdleCoverDelayChange, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app/80 p-4" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="app-preferences-title" className="w-full max-w-md rounded-xl border border-border bg-elevated p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 id="app-preferences-title" className="font-semibold">Preferences</h2>
          <button onClick={onClose} className="dialog-close" aria-label="Close preferences">× Close</button>
        </div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">Appearance</h3>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={idleCoverEnabled} onChange={(event) => onIdleCoverChange(event.target.checked)} aria-describedby="idle-cover-help" className="mt-1" />
          <span>Show looper cover after inactivity</span>
        </label>
        <label htmlFor="idle-cover-delay" className="mt-4 flex items-center justify-between gap-4 text-sm">
          <span>Wait time</span>
          <span className="flex items-center gap-2">
            <select id="idle-cover-delay" aria-label="Looper cover wait time in minutes" disabled={!idleCoverEnabled} value={idleCoverDelayMinutes} onChange={(event) => onIdleCoverDelayChange(Number(event.target.value))} className="rounded border border-border bg-app px-2 py-1.5 text-text disabled:opacity-50">
              {IDLE_COVER_DELAY_OPTIONS_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}
            </select>
            <span className="text-xs text-text-secondary">minutes</span>
          </span>
        </label>
        <p id="idle-cover-help" className="mt-2 text-xs text-text-secondary">While a looper plays, its cover fills the window. Move the pointer inside the window to return to the player. Audio continues normally.</p>
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      </section>
    </div>
  );
}
