import { useEffect, useRef, useState } from "react";
import { useAudioOutputTest } from "../hooks/useAudioOutputTest";
import { useAudioRoutingSession } from "../hooks/useAudioRoutingSession";
import {
  audioOutputDevices,
  audioSetOutput,
  type AudioOutputDevice,
  type AudioOutputSelection,
  type PlayerStatus,
} from "../tauri";
import {
  parseOutputPairSelections,
  normalizeStereoPair,
  rememberedOutputPair,
  rememberOutputPair,
} from "../audioOutputPreferences";
import { audioDeviceOptions } from "../audioDeviceOptions";
import AudioOutputControls from "./AudioOutputControls";
import AudioOutputMeter from "./AudioOutputMeter";

interface Props {
  open: boolean;
  selection: AudioOutputSelection;
  startupError: string | null;
  onSelectionChange: (selection: AudioOutputSelection) => void;
  copySourceOnImport: boolean;
  onCopySourceOnImportChange: (enabled: boolean) => void;
  onPlayerStatusChange: (status: PlayerStatus) => void;
  onOutputTestStarted: () => void;
  onClose: () => void;
}

export default function AudioSettingsDialog({
  open,
  selection,
  startupError,
  onSelectionChange,
  copySourceOnImport,
  onCopySourceOnImportChange,
  onPlayerStatusChange,
  onOutputTestStarted,
  onClose,
}: Props) {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [deviceName, setDeviceName] = useState(selection.deviceName ?? "");
  const [firstChannel, setFirstChannel] = useState(selection.firstChannel);
  const [sampleRate, setSampleRate] = useState(selection.sampleRate?.toString() ?? "");
  const [bufferFrames, setBufferFrames] = useState(selection.bufferFrames?.toString() ?? "");
  const [pairSelections, setPairSelections] = useState<Record<string, number>>(() =>
    parseOutputPairSelections(localStorage.getItem("olooper.audio.output-pairs")),
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeFromBeginningOnClose = useRef(false);
  const { testing, testChannel, setTestChannel, clearTestTimers, resetTest, testPair } = useAudioOutputTest(
    setBusy, setError, resumeFromBeginningOnClose, onOutputTestStarted,
  );

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
    setFirstChannel(normalizeStereoPair(selection.firstChannel));
    setSampleRate(selection.sampleRate?.toString() ?? "");
    setBufferFrames(selection.bufferFrames?.toString() ?? "");
    const remembered = rememberOutputPair(
      parseOutputPairSelections(localStorage.getItem("olooper.audio.output-pairs")),
      selection,
    );
    setPairSelections(remembered);
    localStorage.setItem("olooper.audio.output-pairs", JSON.stringify(remembered));
    setBusy(false);
    resetTest();
    void refreshDevices();
    return clearTestTimers;
  // Refresh once per open; selection changes are made in this dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const outputLevels = useAudioRoutingSession(open, testing, resumeFromBeginningOnClose, setBusy, setError, onPlayerStatusChange);

  const deviceOptions = audioDeviceOptions(devices, deviceName);
  const { systemDefault, selectedAvailable, channelCount } = deviceOptions;

  if (!open) return null;

  const saveSelection = (next: AudioOutputSelection) => {
    const pairs = rememberOutputPair(pairSelections, next);
    localStorage.setItem("olooper.audio.output", JSON.stringify(next));
    localStorage.setItem("olooper.audio.output-pairs", JSON.stringify(pairs));
    setPairSelections(pairs);
    onSelectionChange(next);
  };

  const currentSelection = (): AudioOutputSelection => ({
    deviceName: deviceName || null,
    firstChannel: normalizeStereoPair(firstChannel),
    sampleRate: sampleRate ? Number(sampleRate) : null,
    bufferFrames: bufferFrames ? Number(bufferFrames) : null,
  });

  const apply = async () => {
    setBusy(true);
    setError(null);
    const next = currentSelection();
    try {
      await audioSetOutput(next);
      saveSelection(next);
    } catch (cause) {
      resumeFromBeginningOnClose.current = false;
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm" onClick={() => { if (!busy) onClose(); }}>
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
            <p className="mt-1 text-[10px] text-text-secondary">System default follows the operating system when its default output changes. Playback stops while choosing an output; closing resumes from the start of the loop.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="dialog-close"><span aria-hidden="true">×</span> Close</button>
        </header>

        <label className="block text-xs text-text-secondary">
          Output device
          <select
            value={deviceName}
            onChange={(event) => {
              const nextDevice = event.target.value;
              setDeviceName(nextDevice);
              setFirstChannel(rememberedOutputPair(pairSelections, nextDevice || null));
              const nextAvailable = nextDevice
                ? devices.find((device) => device.id === nextDevice)
                : systemDefault;
              if (sampleRate && !nextAvailable?.sample_rates.includes(Number(sampleRate))) {
                setSampleRate("");
              }
              const requestedBuffer = Number(bufferFrames);
              if (bufferFrames && (nextAvailable?.buffer_size_min == null
                || nextAvailable.buffer_size_max == null
                || requestedBuffer < nextAvailable.buffer_size_min
                || requestedBuffer > nextAvailable.buffer_size_max)) {
                setBufferFrames("");
              }
              setTestChannel(null);
            }}
            disabled={loading || busy}
            className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
          >
            <option value="">System default{systemDefault ? ` — ${systemDefault.name}` : ""}</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.is_default ? " (system default)" : ""}</option>)}
          </select>
        </label>

        <label className="mt-4 flex items-start gap-2 rounded border border-border bg-elevated p-3 text-xs text-text">
          <input
            type="checkbox"
            checked={copySourceOnImport}
            onChange={(event) => onCopySourceOnImportChange(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">Copy SWF/EXE loopers to the library by default</span>
            <span className="mt-1 block text-[10px] text-text-secondary">Sets the default for the import checkbox, for both extracted audio and source playback. Without a copy, source playback requires the original file to stay available.</span>
          </span>
        </label>

        <AudioOutputControls deviceName={deviceName} options={deviceOptions} loading={loading} busy={busy}
          sampleRate={sampleRate} bufferFrames={bufferFrames} firstChannel={firstChannel}
          onSampleRate={setSampleRate} onBufferFrames={setBufferFrames} onFirstChannel={setFirstChannel} />

        <p className="mt-3 text-[10px] text-text-secondary">
          Test plays a 440 Hz tone on L, then 660 Hz on R. The device opens with the selected sample rate and buffer size; “Device default” leaves those choices to the audio device.
        </p>
        <AudioOutputMeter levels={outputLevels} testChannel={testChannel} />
        {(error || startupError) && <p className="mt-3 text-xs text-danger" role="alert">{error || startupError}</p>}

        <footer className="mt-5 flex items-center justify-between">
          <button onClick={() => void refreshDevices()} disabled={loading || busy} className="rounded bg-border px-3 py-2 text-[10px] text-text-secondary hover:text-text disabled:opacity-40">
            {loading ? "Refreshing…" : "Refresh devices"}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => void testPair(currentSelection(), saveSelection)} disabled={loading || busy || !selectedAvailable || channelCount < 2 || firstChannel + 2 > channelCount} className="rounded bg-accent/15 px-3 py-2 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40">
              {testing ? "Testing…" : "Test L/R"}
            </button>
            <button onClick={() => void apply()} disabled={loading || busy || !selectedAvailable || channelCount < 2 || firstChannel + 2 > channelCount} className="rounded bg-accent px-4 py-2 text-[10px] font-medium text-white disabled:opacity-40">
            {busy && !testing ? "Applying…" : "Apply"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
