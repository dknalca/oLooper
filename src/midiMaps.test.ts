import { describe, expect, it } from "vitest";
import { bindMidiMap, exportMidiMap, importMidiMap, MIDI_MAP_STORAGE_KEY, readMidiMaps, type MidiBindings } from "./midiMaps";
import { MIDI_ACTIONS } from "./components/MidiSettingsDialog";

const bindings: MidiBindings = {
  "play-pause": { inputId: "machine-local-id", inputName: "DJM-S11", kind: "note", channel: 1, number: 60 },
  "library-encoder": { inputId: "machine-local-id", inputName: "DJM-S11", kind: "cc", channel: 16, number: 127 },
};
const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
const document = (overrides = {}) => JSON.stringify({
  format: "olooper-midi-map", version: 1, name: "pioneerS11_map",
  bindings: { "play-pause": { kind: "note", channel: 1, number: 60 } }, ...overrides,
});

describe("MIDI map presets", () => {
  it("ships three empty templates and migrates the existing mapping to Custom_map", () => {
    const empty = readMidiMaps(storage({}));
    expect(empty.presets.map((preset) => preset.name)).toEqual(["Custom_map", "pioneerS11_map", "Rane72map"]);
    expect(empty.presets.every((preset) => Object.keys(preset.bindings).length === 0)).toBe(true);
    const migrated = readMidiMaps(storage({ "olooper.midi.bindings": JSON.stringify(bindings) }));
    expect(migrated.bindings).toEqual(bindings);
    expect(migrated.presets[0].bindings).toEqual(bindings);
  });

  it("restores saved snapshots independently of current edits across restarts", () => {
    const state = readMidiMaps(storage({ "olooper.midi.bindings": JSON.stringify(bindings) }));
    state.bindings = {};
    state.activeName = "pioneerS11_map";
    expect(readMidiMaps(storage({ [MIDI_MAP_STORAGE_KEY]: JSON.stringify(state) }))).toEqual(state);
    expect(state.presets[0].bindings).toEqual(bindings);
  });

  it("preserves valid legacy assignments alongside invalid or obsolete entries", () => {
    const state = readMidiMaps(storage({ "olooper.midi.bindings": JSON.stringify({
      ...bindings, stop: { kind: "note", channel: 99 }, obsolete: { kind: "note" },
    }) }));
    expect(state.bindings).toEqual(bindings);
  });

  it("rejects rebinding two formerly separate controls onto one duplicate control", () => {
    const separate: MidiBindings = {
      stop: { inputId: "first", inputName: "First", kind: "note", channel: 1, number: 60 },
      next: { inputId: "second", inputName: "Second", kind: "note", channel: 1, number: 60 },
    };
    expect(() => bindMidiMap(separate, { id: "merged", name: "Merged" })).toThrow("multiple actions");
  });

  it("exports portable JSON and rebinds it to hardware on another computer", () => {
    const text = exportMidiMap("pioneerS11_map", bindings);
    expect(text).not.toContain("machine-local-id");
    expect(text).not.toContain("DJM-S11");
    const imported = importMidiMap(text);
    expect(imported.name).toBe("pioneerS11_map");
    expect(imported.bindings["play-pause"]?.inputId).toBe("");
    const rebound = bindMidiMap(imported.bindings, { id: "new-id", name: "New MIDI input" });
    expect(rebound["play-pause"]).toEqual({ ...bindings["play-pause"], inputId: "new-id", inputName: "New MIDI input" });
    expect(imported.bindings["play-pause"]?.inputId).toBe("");
  });

  it("accepts every supported UI action and boundary channel/note values", () => {
    for (const { id } of MIDI_ACTIONS) {
      expect(importMidiMap(document({ bindings: { [id]: { kind: "cc", channel: 16, number: 0 } } })).bindings[id]).toBeDefined();
    }
  });

  it("rejects malformed documents, unsupported versions and invalid bindings", () => {
    for (const text of ["not JSON", "null", "[]", document({ version: 2 }), document({ format: "other" }),
      document({ name: " " }), document({ name: "a".repeat(81) }), document({ bindings: [] }),
      document({ bindings: { unknown: { kind: "note", channel: 1, number: 60 } } }),
      ...[
        { kind: "sysex", channel: 1, number: 60 }, { kind: "note", channel: 0, number: 60 },
        { kind: "note", channel: 17, number: 60 }, { kind: "note", channel: 1.5, number: 60 },
        { kind: "note", channel: 1, number: -1 }, { kind: "note", channel: 1, number: 128 },
        { kind: "note", channel: 1, number: "60" },
      ].map((binding) => document({ bindings: { stop: binding } })),
      document({ bindings: { stop: { kind: "note", channel: 1, number: 60 }, next: { kind: "note", channel: 1, number: 60 } } }),
      " ".repeat(65537),
    ]) expect(() => importMidiMap(text)).toThrow();
  });

  it("recovers legacy preferences if stored preset data is corrupt", () => {
    const restored = readMidiMaps(storage({
      [MIDI_MAP_STORAGE_KEY]: '{"version":2}', "olooper.midi.bindings": JSON.stringify(bindings),
    }));
    expect(restored.bindings).toEqual(bindings);
  });
});
