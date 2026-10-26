import type { MidiAction, MidiBinding, MidiInputInfo } from "./tauri";
import customMap from "./midi-presets/Custom_map.json";
import pioneerS11Map from "./midi-presets/pioneerS11_map.json";
import rane72Map from "./midi-presets/Rane72map.json";

export type MidiBindings = Partial<Record<MidiAction, MidiBinding>>;
export const MIDI_MAP_STORAGE_KEY = "olooper.midi.maps";
const BUILTIN_MAPS = [customMap, pioneerS11Map, rane72Map];
const ACTIONS: MidiAction[] = [
  "play-pause", "stop", "previous", "next", "random-loop", "volume-down", "volume-up",
  "metronome-toggle", "cue-1", "cue-2", "cue-3", "cue-4", "clear-cue-2", "clear-cue-3",
  "clear-cue-4", "library-encoder", "library-up", "library-down", "library-intro", "library-back",
];

export interface MidiMapState {
  version: 1;
  presets: { name: string; bindings: MidiBindings }[];
  activeName: string;
  bindings: MidiBindings;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function midiMapName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f]/.test(value)) {
    throw new Error("Map name must contain 1–80 characters without control characters.");
  }
  return value.trim();
}

function parseBindings(value: unknown, portable = false): MidiBindings {
  if (!record(value)) throw new Error("Invalid MIDI bindings.");
  const bindings: MidiBindings = {};
  const controls = new Set<string>();
  for (const [action, raw] of Object.entries(value)) {
    if (!ACTIONS.includes(action as MidiAction) || !record(raw)
      || (raw.kind !== "note" && raw.kind !== "cc")
      || !Number.isInteger(raw.channel) || Number(raw.channel) < 1 || Number(raw.channel) > 16
      || !Number.isInteger(raw.number) || Number(raw.number) < 0 || Number(raw.number) > 127
      || (!portable && (typeof raw.inputId !== "string" || typeof raw.inputName !== "string"))) {
      throw new Error(`Invalid MIDI assignment: ${action}.`);
    }
    const binding: MidiBinding = {
      inputId: portable ? "" : raw.inputId as string,
      inputName: portable ? "Unassigned input" : raw.inputName as string,
      kind: raw.kind, channel: raw.channel as number, number: raw.number as number,
    };
    const key = `${binding.inputId}:${binding.kind}:${binding.channel}:${binding.number}`;
    if (controls.has(key)) throw new Error("A MIDI control cannot be assigned to multiple actions.");
    controls.add(key);
    bindings[action as MidiAction] = binding;
  }
  return bindings;
}

export function bindMidiMap(bindings: MidiBindings, input: MidiInputInfo | null): MidiBindings {
  return parseBindings(Object.fromEntries(Object.entries(bindings).map(([action, binding]) => [
    action, input ? { ...binding, inputId: input.id, inputName: input.name } : { ...binding },
  ])));
}

export function exportMidiMap(name: string, bindings: MidiBindings): string {
  const portable = Object.fromEntries(Object.entries(bindings).map(([action, binding]) => [
    action, { kind: binding.kind, channel: binding.channel, number: binding.number },
  ]));
  parseBindings(portable, true);
  return JSON.stringify({ format: "olooper-midi-map", version: 1, name: midiMapName(name), bindings: portable }, null, 2) + "\n";
}

export function importMidiMap(text: string): { name: string; bindings: MidiBindings } {
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new Error("MIDI map exceeds 64 KiB.");
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.format !== "olooper-midi-map" || value.version !== 1) {
    throw new Error("Unsupported MIDI map format or version.");
  }
  return { name: midiMapName(value.name), bindings: parseBindings(value.bindings, true) };
}

export function readMidiMaps(storage: Pick<Storage, "getItem">): MidiMapState {
  const initial: MidiMapState = {
    version: 1, activeName: "Custom_map", bindings: {},
    presets: BUILTIN_MAPS.map((map) => importMidiMap(JSON.stringify(map))),
  };
  try {
    const text = storage.getItem(MIDI_MAP_STORAGE_KEY);
    if (text) {
      const value: unknown = JSON.parse(text);
      if (!record(value) || value.version !== 1 || !Array.isArray(value.presets)) throw new Error("Invalid presets.");
      const presets = value.presets.map((preset: unknown) => {
        if (!record(preset)) throw new Error("Invalid preset.");
        return { name: midiMapName(preset.name), bindings: parseBindings(preset.bindings) };
      });
      if (new Set(presets.map((preset) => preset.name)).size !== presets.length) throw new Error("Duplicate presets.");
      for (const preset of initial.presets) {
        if (!presets.some((existing) => existing.name === preset.name)) presets.push(preset);
      }
      const activeName = midiMapName(value.activeName);
      if (!presets.some((preset) => preset.name === activeName)) throw new Error("Unknown active preset.");
      return { version: 1, presets, activeName, bindings: parseBindings(value.bindings) };
    }
  } catch { /* Recover the previous mapping if the preset preference is invalid. */ }
  try {
    const legacy: unknown = JSON.parse(storage.getItem("olooper.midi.bindings") ?? "{}");
    if (record(legacy)) {
      for (const action of ACTIONS) {
        if (!(action in legacy)) continue;
        try {
          initial.bindings = parseBindings({ ...initial.bindings, [action]: legacy[action] });
        } catch { /* Preserve valid legacy assignments when another is malformed. */ }
      }
    }
    initial.presets[0].bindings = initial.bindings;
  } catch { /* Fresh installation or invalid legacy preference. */ }
  return initial;
}
