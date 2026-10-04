import type { AudioOutputSelection } from "./tauri";

const SYSTEM_DEFAULT = "@system-default";

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
