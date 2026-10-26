export const IDLE_COVER_KEY = "olooper.appearance.idle-cover-enabled";
export const IDLE_COVER_DELAY_KEY = "olooper.appearance.idle-cover-delay-minutes";
export const DEFAULT_IDLE_COVER_DELAY_MINUTES = 2;
export const IDLE_COVER_DELAY_OPTIONS_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60] as const;
export const IDLE_COVER_DELAY_MS = DEFAULT_IDLE_COVER_DELAY_MINUTES * 60 * 1000;

export function readIdleCoverDelayMinutes(): number {
  try {
    const value = Number(localStorage.getItem(IDLE_COVER_DELAY_KEY));
    return IDLE_COVER_DELAY_OPTIONS_MINUTES.includes(value as typeof IDLE_COVER_DELAY_OPTIONS_MINUTES[number])
      ? value
      : DEFAULT_IDLE_COVER_DELAY_MINUTES;
  } catch { return DEFAULT_IDLE_COVER_DELAY_MINUTES; }
}

export function saveIdleCoverDelayMinutes(minutes: number): string | null {
  if (!IDLE_COVER_DELAY_OPTIONS_MINUTES.includes(minutes as typeof IDLE_COVER_DELAY_OPTIONS_MINUTES[number])) {
    return "Choose a wait time between 1 and 60 minutes.";
  }
  try { localStorage.setItem(IDLE_COVER_DELAY_KEY, String(minutes)); return null; }
  catch { return "This preference could not be saved. Your choice applies for this session."; }
}

export function idleCoverDelayMs(minutes: number): number {
  return IDLE_COVER_DELAY_OPTIONS_MINUTES.includes(minutes as typeof IDLE_COVER_DELAY_OPTIONS_MINUTES[number])
    ? minutes * 60 * 1000
    : IDLE_COVER_DELAY_MS;
}

export function readIdleCoverEnabled(): boolean {
  try {
    const stored = localStorage.getItem(IDLE_COVER_KEY);
    return stored === null || stored === "true";
  } catch { return true; }
}

export function saveIdleCoverEnabled(enabled: boolean): string | null {
  try { localStorage.setItem(IDLE_COVER_KEY, String(enabled)); return null; }
  catch { return "This preference could not be saved. Your choice applies for this session."; }
}
