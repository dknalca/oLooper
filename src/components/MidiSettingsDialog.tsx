import { useEffect } from "react";
import MidiMapPresets from "./MidiMapPresets";
import type { MidiMapState } from "../midiMaps";
import type { MidiAction, MidiBinding } from "../tauri";
import { useMidiDevices } from "../hooks/useMidiDevices";

export const MIDI_ACTIONS: { id: MidiAction; label: string; group: string }[] = [
  { id: "play-pause", label: "Play / Pause", group: "Transport" },
  { id: "stop", label: "Stop", group: "Transport" },
  { id: "previous", label: "Previous loop", group: "Transport" },
  { id: "next", label: "Next loop", group: "Transport" },
  { id: "random-loop", label: "Random Loop", group: "Transport" },
  { id: "volume-down", label: "Volume down (5%)", group: "Audio" },
  { id: "volume-up", label: "Volume up (5%)", group: "Audio" },
  { id: "metronome-toggle", label: "Toggle metronome", group: "Practice" },
  ...Array.from({ length: 4 }, (_, index) => ({
    id: `cue-${index + 1}` as MidiAction,
    label: `CUE ${index + 1}`,
    group: "Cues",
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    id: `clear-cue-${index + 2}` as MidiAction,
    label: `Clear CUE ${index + 2}`,
    group: "Cues",
  })),
  { id: "library-encoder", label: "Library encoder (relative CC)", group: "Library" },
  { id: "library-up", label: "Library Up", group: "Library" },
  { id: "library-down", label: "Library Down", group: "Library" },
  { id: "library-intro", label: "Library Intro", group: "Library" },
  { id: "library-back", label: "Library Back", group: "Library" },
];

interface Props {
  open: boolean;
  inputId: string | null;
  outputId: string | null;
  bindings: Partial<Record<MidiAction, MidiBinding>>;
  maps: MidiMapState;
  onMapsChange: (maps: MidiMapState) => void;
  learningAction: MidiAction | null;
  conflictAction: MidiAction | null;
  onInputIdChange: (id: string | null) => void;
  onOutputIdChange: (id: string | null) => void;
  onLearningChange: (action: MidiAction | null) => void;
  onClearBinding: (action: MidiAction) => void;
  onClose: () => void;
}

function bindingLabel(binding: MidiBinding): string {
  return `${binding.inputName} · Ch ${binding.channel} · ${binding.kind === "note" ? "Note" : "CC"} ${binding.number}`;
}

export default function MidiSettingsDialog({
  open,
  inputId,
  outputId,
  bindings,
  maps,
  onMapsChange,
  learningAction,
  conflictAction,
  onInputIdChange,
  onOutputIdChange,
  onLearningChange,
  onClearBinding,
  onClose,
}: Props) {
  const { devices, outputDevices, connected, connectedOutput, selectedId, setSelectedId, selectedOutputId,
    setSelectedOutputId, loading, busy, error, refreshDevices, connect, disconnect, connectOutput } =
    useMidiDevices(open, inputId, outputId, onInputIdChange, onOutputIdChange, onLearningChange);
  const selectedIsConnected = connected?.id === selectedId;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="midi-options-title"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 id="midi-options-title" className="text-base font-semibold text-text">MIDI Options</h2>
            <p className="mt-1 text-[10px] text-text-secondary">Assign Note On and discrete CC buttons to oLooper actions.</p>
          </div>
          <button onClick={onClose} className="dialog-close"><span aria-hidden="true">×</span> Close</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="mb-4 rounded border border-border bg-elevated/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex-1 text-[10px] text-text-secondary">
              MIDI input
              <select
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  onInputIdChange(event.target.value || null);
                }}
                disabled={loading || busy || devices.length === 0}
                className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text disabled:opacity-50"
              >
                {devices.length === 0 && <option value="">No MIDI inputs found</option>}
                {devices.map((device) => {
                  const hasDuplicateName = devices.some((candidate) => candidate.id !== device.id && candidate.name === device.name);
                  const label = hasDuplicateName ? `${device.name} (${device.id})` : device.name;
                  return <option key={device.id} value={device.id}>{label}</option>;
                })}
              </select>
            </label>
            <button onClick={() => void refreshDevices()} disabled={loading || busy} className="mt-4 rounded bg-border px-2.5 py-1.5 text-[10px] text-text-secondary hover:text-text disabled:opacity-40">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            {selectedIsConnected
              ? <button onClick={() => void disconnect()} disabled={busy} className="mt-4 rounded bg-danger/15 px-2.5 py-1.5 text-[10px] text-danger disabled:opacity-40">Disconnect</button>
              : <button onClick={() => void connect()} disabled={!selectedId || busy} className="mt-4 rounded bg-accent px-2.5 py-1.5 text-[10px] font-medium text-white disabled:opacity-40">{connected ? "Switch input" : "Connect"}</button>}
          </div>
          <p className="mt-2 text-[10px] text-text-secondary" role="status">
            {selectedIsConnected ? `Connected: ${connected.name}` : connected ? `Connected to ${connected.name}; select Switch input to change.` : "Connect a MIDI input to learn or use assignments."}
          </p>
          <p className="mt-1 text-[10px] text-text-secondary">
            USB and Bluetooth MIDI inputs appear here when the operating system exposes them. Connect Bluetooth devices in system settings first, then select Refresh.
          </p>
          {error && <p className="mt-1 text-[10px] text-danger" role="alert">{error}</p>}
        </section>

        <section className="mb-4 rounded border border-border bg-elevated/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex-1 text-[10px] text-text-secondary">
              MIDI output for pad lights
              <select value={selectedOutputId} onChange={(event) => setSelectedOutputId(event.target.value)} disabled={loading || busy} className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1.5 text-xs text-text disabled:opacity-50">
                <option value="">No output</option>
                {outputDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
              </select>
            </label>
            <button onClick={() => void connectOutput()} disabled={busy || selectedOutputId === connectedOutput?.id} className="mt-4 rounded bg-accent px-2.5 py-1.5 text-[10px] font-medium text-white disabled:opacity-40">Apply output</button>
          </div>
          <p className="mt-2 text-[10px] text-text-secondary">When supported by the controller, assigned Note/CC pads are lit using MIDI feedback. LED color depends on the controller.</p>
        </section>

        <MidiMapPresets maps={maps} input={connected} onChange={onMapsChange} />

        {conflictAction && (
          <p className="mb-3 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-[10px] text-text" role="status">
            This control was already assigned to {MIDI_ACTIONS.find((action) => action.id === conflictAction)?.label}. Its assignment moved to the action you just learned.
          </p>
        )}

        <div>
          {(["Transport", "Cues", "Library", "Audio", "Practice"] as const).map((group) => (
            <section key={group} className="mb-4">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">{group}</h3>
              <div className="divide-y divide-border/60 rounded border border-border px-3">
                {MIDI_ACTIONS.filter((action) => action.group === group).map(({ id, label }) => {
                  const binding = bindings[id];
                  const learning = learningAction === id;
                  return (
                    <div key={id} className="flex min-h-10 items-center gap-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-text">{label}</span>
                      <span className="min-w-0 truncate text-right text-[10px] text-text-secondary">
                        {learning ? id === "library-encoder" ? "Turn the encoder…" : "Press a pad or CC button…" : binding ? bindingLabel(binding) : "Unassigned"}
                      </span>
                      <button
                        onClick={() => onLearningChange(learning ? null : id)}
                        disabled={!selectedIsConnected || busy || (learningAction !== null && !learning)}
                        className="shrink-0 rounded bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40"
                      >{learning ? "Cancel" : "Learn"}</button>
                      {binding && <button onClick={() => onClearBinding(id)} aria-label={`Clear ${label} MIDI assignment`} className="rounded px-1.5 py-1 text-xs text-text-secondary hover:bg-danger/10 hover:text-danger">×</button>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        </div>
        <p className="mt-2 text-[10px] text-text-secondary">Note On triggers on press. Button CCs trigger on 0→nonzero. The library encoder uses relative CC values below 64 for down and above 64 for up; 0 and 64 are ignored. Assignments are stored locally per input.</p>
      </section>
    </div>
  );
}
