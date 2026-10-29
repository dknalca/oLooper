import type { AudioOutputSelection } from "./tauri";

const SYSTEM_DEFAULT = "@system-default";
const DEFAULT_OUTPUT: AudioOutputSelection = {
  deviceName: null,
  firstChannel: 0,
  sampleRate: null,
  bufferFrames: null,
};

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function parseAudioSelection(value: unknown): AudioOutputSelection | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as Partial<AudioOutputSelection>;
  if ((selection.deviceName !== null && typeof selection.deviceName !== "string")
    || typeof selection.firstChannel !== "number"
    || !Number.isInteger(selection.firstChannel)
    || selection.firstChannel < 0
    || selection.firstChannel > 62) return null;
  return {
    deviceName: selection.deviceName,
    firstChannel: normalizeStereoPair(selection.firstChannel),
    sampleRate: positiveInteger(selection.sampleRate),
    bufferFrames: positiveInteger(selection.bufferFrames),
  };
}

/** Read the last output configuration, falling back to the system default. */
export function readAudioSelection(storage?: Pick<Storage, "getItem">): AudioOutputSelection {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem("olooper.audio.output") ?? "null");
    return parseAudioSelection(value) ?? { ...DEFAULT_OUTPUT };
  } catch {
    // Unavailable storage and invalid JSON both use the system default.
  }
  return { ...DEFAULT_OUTPUT };
}

export function normalizeStereoPair(firstChannel: number): number {
  return Math.floor(firstChannel / 2) * 2;
}

function preferenceKey(deviceName: string | null): string {
  return deviceName ?? SYSTEM_DEFAULT;
}

export function parseOutputPairSelections(serialized: string | null): Record<string, number> {
  if (!serialized) return {};
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, channel]) => Number.isInteger(channel) && (channel as number) >= 0 && (channel as number) <= 62)
        .map(([device, channel]) => [device, normalizeStereoPair(channel as number)]),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

export function rememberedOutputPair(
  selections: Record<string, number>,
  deviceName: string | null,
): number {
  return selections[preferenceKey(deviceName)] ?? 0;
}

export function rememberOutputPair(
  selections: Record<string, number>,
  selection: AudioOutputSelection,
): Record<string, number> {
  return { ...selections, [preferenceKey(selection.deviceName)]: normalizeStereoPair(selection.firstChannel) };
}
