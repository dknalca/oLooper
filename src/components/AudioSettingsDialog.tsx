import { useEffect, useMemo, useState } from "react";
import {
  audioOutputDevices,
  audioSetOutput,
  type AudioOutputDevice,
  type AudioOutputSelection,
} from "../tauri";

interface Props {
  open: boolean;
  selection: AudioOutputSelection;
  onSelectionChange: (selection: AudioOutputSelection) => void;
  onClose: () => void;
}

export default function AudioSettingsDialog({ open, selection, onSelectionChange, onClose }: Props) {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [deviceName, setDeviceName] = useState(selection.deviceName ?? "");
  const [firstChannel, setFirstChannel] = useState(selection.firstChannel);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      setDevices(await audioOutputDevices());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setDeviceName(selection.deviceName ?? "");
    setFirstChannel(selection.firstChannel);
    void refreshDevices();
  // Refresh once per open; selection changes are made in this dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === deviceName),
    [devices, deviceName],
  );
  const systemDefault = devices.find((device) => device.is_default);
  const channelCount = deviceName ? selectedDevice?.channels ?? 0 : systemDefault?.channels ?? 2;
  const pairCount = Math.max(1, channelCount - 1);

  if (!open) return null;

  const apply = async () => {
    setBusy(true);
    setError(null);
    const next = { deviceName: deviceName || null, firstChannel };
    try {
      await audioSetOutput(next);
      localStorage.setItem("olooper.audio.output", JSON.stringify(next));
      onSelectionChange(next);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-options-title"
        className="w-full max-w-xl rounded-lg border border-border bg-surface p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 id="audio-options-title" className="text-base font-semibold text-text">Audio Output</h2>
            <p className="mt-1 text-[10px] text-text-secondary">Choose where oLooper sends its stereo playback.</p>
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-border hover:text-text">Close</button>
        </header>

        <label className="block text-xs text-text-secondary">
          Output device
          <select
            value={deviceName}
            onChange={(event) => { setDeviceName(event.target.value); setFirstChannel(0); }}
            disabled={loading || busy}
            className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
          >
            <option value="">System default{systemDefault ? ` — ${systemDefault.name}` : ""}</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (system default)" : ""}</option>)}
          </select>
        </label>

        <label className="mt-4 block text-xs text-text-secondary">
          Stereo output pair
          <select
            value={firstChannel}
            onChange={(event) => setFirstChannel(Number(event.target.value))}
            disabled={loading || busy || channelCount < 2}
            className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
          >
            {Array.from({ length: pairCount }, (_, index) => (
              <option key={index} value={index}>Output {index + 1}–{index + 2}</option>
            ))}
          </select>
        </label>

        <p className="mt-3 text-[10px] text-text-secondary">
          System default follows the output selected in macOS. For a DJ mixer, choose its device and select the stereo pair connected to your channel, such as Output 2–3.
        </p>
        {error && <p className="mt-3 text-xs text-danger" role="alert">{error}</p>}

        <footer className="mt-5 flex items-center justify-between">
          <button onClick={() => void refreshDevices()} disabled={loading || busy} className="rounded bg-border px-3 py-2 text-[10px] text-text-secondary hover:text-text disabled:opacity-40">
            {loading ? "Refreshing…" : "Refresh devices"}
          </button>
          <button onClick={() => void apply()} disabled={loading || busy || (deviceName !== "" && !selectedDevice)} className="rounded bg-accent px-4 py-2 text-[10px] font-medium text-white disabled:opacity-40">
            {busy ? "Applying…" : "Apply"}
          </button>
        </footer>
      </section>
    </div>
  );
}
