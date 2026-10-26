import { useState } from "react";
import { bindMidiMap, exportMidiMap, importMidiMap, midiMapName, type MidiMapState } from "../midiMaps";
import { midiImportMapFile, midiExportMapFile, type MidiInputInfo } from "../tauri";

interface Props {
  maps: MidiMapState;
  input: MidiInputInfo | null;
  onChange: (maps: MidiMapState) => void;
}

export default function MidiMapPresets({ maps, input, onChange }: Props) {
  const [selected, setSelected] = useState(maps.activeName);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const saved = maps.presets.find((preset) => preset.name === maps.activeName);
  const dirty = JSON.stringify(saved?.bindings) !== JSON.stringify(maps.bindings);
  const buttonClass = "rounded bg-border px-2.5 py-1.5 text-[10px] text-text-secondary hover:text-text disabled:opacity-40";

  const run = async (operation: () => void | Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try { await operation(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const save = (newName: string, create: boolean) => {
    const validName = midiMapName(newName);
    if (create && maps.presets.some((preset) => preset.name.toLowerCase() === validName.toLowerCase())) {
      throw new Error("A preset with this name already exists. Load it and use Save preset to update it.");
    }
    const preset = { name: validName, bindings: bindMidiMap(maps.bindings, null) };
    onChange({ ...maps, activeName: validName, presets: create
      ? [...maps.presets, preset]
      : maps.presets.map((existing) => existing.name === validName ? preset : existing) });
    setSelected(validName);
    setName("");
    setStatus(`Saved ${validName}.`);
  };

  return (
    <section className="mb-4 rounded border border-border bg-elevated/50 p-3" aria-label="MIDI map presets">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-[10px] text-text-secondary">
          MIDI map preset
          <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy}
            className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text">
            {maps.presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}{Object.keys(preset.bindings).length === 0 ? " (empty)" : ""}</option>)}
          </select>
        </label>
        <button disabled={busy} className={buttonClass} onClick={() => void run(() => {
          const preset = maps.presets.find((candidate) => candidate.name === selected);
          if (!preset) return;
          onChange({ ...maps, activeName: preset.name, bindings: bindMidiMap(preset.bindings, input) });
          setStatus(`Loaded ${preset.name}${input ? ` for ${input.name}` : ""}.`);
        })}>Load preset</button>
        <button disabled={busy} className={buttonClass} onClick={() => void run(() => save(maps.activeName, false))}>Save preset</button>
      </div>
      <p className="mt-2 text-[10px] text-text-secondary">Active: {maps.activeName}{dirty ? " · Modified — save to update the preset" : " · Saved"}. Loading replaces current assignments{input ? ` and assigns them to ${input.name}` : "; connect an input and load again to use a shared map"}.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input aria-label="New MIDI map name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80}
          placeholder="New name, e.g. pioneerS11_map" disabled={busy}
          className="min-w-40 flex-1 rounded border border-border bg-surface px-2 py-1.5 text-xs text-text" />
        <button disabled={busy || !name.trim()} className={buttonClass} onClick={() => void run(() => save(name, true))}>Save as</button>
        <button disabled={busy} className={buttonClass} onClick={() => void run(async () => {
          const text = await midiImportMapFile();
          if (text === null) return;
          const imported = importMidiMap(text);
          let uniqueName = imported.name;
          let suffix = 2;
          while (maps.presets.some((preset) => preset.name.toLowerCase() === uniqueName.toLowerCase())) {
            uniqueName = `${imported.name.slice(0, 70)} (${suffix++})`;
          }
          const preset = { name: uniqueName, bindings: bindMidiMap(imported.bindings, input) };
          onChange({ ...maps, activeName: uniqueName, bindings: preset.bindings, presets: [...maps.presets, preset] });
          setSelected(uniqueName);
          setStatus(`Imported ${uniqueName}.`);
        })}>Import MIDI map</button>
        <button disabled={busy} className={buttonClass} onClick={() => void run(async () => {
          const contents = exportMidiMap(maps.activeName, maps.bindings);
          const filename = maps.activeName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
          if (await midiExportMapFile(filename, contents)) setStatus(`Exported ${maps.activeName}.`);
        })}>Export MIDI map</button>
      </div>
      <p className="mt-2 text-[10px] text-text-secondary">Export shares the current assignments as JSON, without local device IDs. Empty presets are templates to complete with Learn. Current edits are remembered across restarts.</p>
      {status && <p role="status" className="mt-2 text-[10px] text-text-secondary">{status}</p>}
      {error && <p role="alert" className="mt-2 text-[10px] text-danger">{error}</p>}
    </section>
  );
}
