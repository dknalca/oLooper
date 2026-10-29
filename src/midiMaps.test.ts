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

  it("preserves only the first valid legacy assignment when controls collide", () => {
    const state = readMidiMaps(storage({ "olooper.midi.bindings": JSON.stringify({
      "play-pause": bindings["play-pause"],
      stop: { ...bindings["play-pause"] },
      next: { inputId: "other", inputName: "Other", kind: "note", channel: 1, number: 60 },
    }) }));
    expect(state.bindings["play-pause"]).toEqual(bindings["play-pause"]);
    expect(state.bindings.stop).toBeUndefined();
    expect(state.bindings.next?.inputId).toBe("other");
  });

  it("rejects malformed saved presets and recovers valid legacy bindings", () => {
    const state = readMidiMaps(storage({
      [MIDI_MAP_STORAGE_KEY]: JSON.stringify({ version: 1, activeName: "Unknown", presets: [], bindings: {} }),
      "olooper.midi.bindings": JSON.stringify(bindings),
    }));
    expect(state.activeName).toBe("Custom_map");
    expect(state.bindings).toEqual(bindings);
  });

  it("does not confuse note and CC controls or channels at the same address", () => {
    const portable = document({ bindings: {
      stop: { kind: "note", channel: 1, number: 127 },
      next: { kind: "cc", channel: 1, number: 127 },
      previous: { kind: "note", channel: 16, number: 127 },
    } });
    expect(Object.keys(importMidiMap(portable).bindings)).toHaveLength(3);
  });

  it("ignores machine-local identifiers in portable maps", () => {
    const imported = importMidiMap(document({ bindings: {
      stop: { kind: "note", channel: 1, number: 0, inputId: "old-id", inputName: "old device" },
    } }));
    expect(imported.bindings.stop).toEqual({ inputId: "", inputName: "Unassigned input", kind: "note", channel: 1, number: 0 });
  });

  it("enforces the import limit in UTF-8 bytes rather than character count", () => {
    const text = document({ padding: "é".repeat(33_000) });
    expect(text.length).toBeLessThan(64 * 1024);
    expect(() => importMidiMap(text)).toThrow("64 KiB");
  });

  it("returns defaults if both current and legacy storage reads fail", () => {
    const result = readMidiMaps({ getItem: () => { throw new Error("unavailable"); } });
    expect(result.activeName).toBe("Custom_map");
    expect(result.bindings).toEqual({});
    expect(result.presets).toHaveLength(3);
  });

  it("rejects duplicate saved preset names and restores legacy mappings", () => {
    const repeated = { name: "Duplicate", bindings: {} };
    const state = readMidiMaps(storage({
      [MIDI_MAP_STORAGE_KEY]: JSON.stringify({ version: 1, activeName: "Duplicate", presets: [repeated, repeated], bindings: {} }),
      "olooper.midi.bindings": JSON.stringify(bindings),
    }));
    expect(state.activeName).toBe("Custom_map");
    expect(state.bindings).toEqual(bindings);
  });

  it("ignores legacy bindings without local input identity", () => {
    const state = readMidiMaps(storage({ "olooper.midi.bindings": JSON.stringify({
      stop: { kind: "note", channel: 1, number: 60 },
      next: bindings["play-pause"],
    }) }));
    expect(state.bindings.stop).toBeUndefined();
    expect(state.bindings.next).toEqual(bindings["play-pause"]);
  });
});
