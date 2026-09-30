import { useEffect, useState } from "react";
import {
  midiConnectedInput,
  midiConnect,
  midiDisconnect,
  midiListInputs,
  type MidiAction,
  type MidiBinding,
  type MidiInputInfo,
} from "../tauri";

export const MIDI_ACTIONS: { id: MidiAction; label: string; group: string }[] = [
  { id: "play-pause", label: "Play / Pause", group: "Transport" },
  { id: "stop", label: "Stop", group: "Transport" },
  { id: "previous", label: "Previous loop", group: "Transport" },
  { id: "next", label: "Next loop", group: "Transport" },
  { id: "toggle-loop", label: "Toggle loop", group: "Transport" },
  { id: "auto-loop", label: "Auto-detect loop", group: "Transport" },
  { id: "speed-down", label: "Slower (5%)", group: "Transport" },
  { id: "speed-up", label: "Faster (5%)", group: "Transport" },
  { id: "cue-1", label: "Cue 1 (track start)", group: "Cues" },
  { id: "cue-2", label: "Cue 2", group: "Cues" },
  { id: "cue-3", label: "Cue 3", group: "Cues" },
  { id: "cue-4", label: "Cue 4", group: "Cues" },
  { id: "clear-cue-2", label: "Clear Cue 2", group: "Cues" },
  { id: "clear-cue-3", label: "Clear Cue 3", group: "Cues" },
  { id: "clear-cue-4", label: "Clear Cue 4", group: "Cues" },
];

interface Props {
  open: boolean;
  inputId: string | null;
  bindings: Partial<Record<MidiAction, MidiBinding>>;
  learningAction: MidiAction | null;
  conflictAction: MidiAction | null;
  onInputIdChange: (id: string | null) => void;
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
  bindings,
  learningAction,
  conflictAction,
  onInputIdChange,
  onLearningChange,
  onClearBinding,
  onClose,
}: Props) {
  const [devices, setDevices] = useState<MidiInputInfo[]>([]);
  const [connected, setConnected] = useState<MidiInputInfo | null>(null);
  const [selectedId, setSelectedId] = useState(inputId ?? "");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const [available, active] = await Promise.all([midiListInputs(), midiConnectedInput()]);
      setDevices(available);
      setConnected(active);
      setSelectedId((current) => {
        if (current && available.some((device) => device.id === current)) return current;
        if (inputId && available.some((device) => device.id === inputId)) return inputId;
        return active?.id ?? available[0]?.id ?? "";
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refreshDevices();
    else onLearningChange(null);
  }, [open]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (open && event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const connect = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const device = await midiConnect(selectedId);
      setConnected(device);
      onInputIdChange(device.id);
      onLearningChange(null);
    } catch (reason) {
      setError(String(reason));
      setConnected(null);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    onLearningChange(null);
    try {
      await midiDisconnect();
      setConnected(null);
      onInputIdChange(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectedIsConnected = connected?.id === selectedId;

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
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-border hover:text-text">Close</button>
        </header>

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
            USB and Bluetooth MIDI inputs are supported when macOS exposes them here. Pair Bluetooth devices in macOS first, then select Refresh.
          </p>
          {error && <p className="mt-1 text-[10px] text-danger" role="alert">{error}</p>}
        </section>

        {conflictAction && (
          <p className="mb-3 rounded border border-accent/30 bg-accent/10 px-3 py-2 text-[10px] text-text" role="status">
            This control was already assigned to {MIDI_ACTIONS.find((action) => action.id === conflictAction)?.label}. Its assignment moved to the action you just learned.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {(["Transport", "Cues"] as const).map((group) => (
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
                        {learning ? "Press a pad or CC button…" : binding ? bindingLabel(binding) : "Unassigned"}
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
        <p className="mt-2 text-[10px] text-text-secondary">Note On triggers on press. CC controls are treated as buttons: one action on 0→nonzero, re-armed at 0. Assignments are stored locally per input.</p>
      </section>
    </div>
  );
}
