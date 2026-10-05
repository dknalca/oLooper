import { useEffect, useMemo, useRef, useState } from "react";
import {
  audioOutputDevices,
  audioSetOutput,
  audioTestOutput,
  playerStatus,
  playerPlay,
  playerStop,
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

interface Props {
  open: boolean;
  selection: AudioOutputSelection;
  startupError: string | null;
  onSelectionChange: (selection: AudioOutputSelection) => void;
  onPlayerStatusChange: (status: PlayerStatus) => void;
  onOutputTestStarted: () => void;
  onClose: () => void;
}

export default function AudioSettingsDialog({
  open,
  selection,
  startupError,
  onSelectionChange,
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
  const [testing, setTesting] = useState(false);
  const [testChannel, setTestChannel] = useState<"left" | "right" | null>(null);
  const [outputLevels, setOutputLevels] = useState({ left: 0, right: 0 });
  const [error, setError] = useState<string | null>(null);
  const testTimers = useRef<number[]>([]);
  const resumeFromBeginningOnClose = useRef(false);

  const clearTestTimers = () => {
    for (const timer of testTimers.current) window.clearTimeout(timer);
    testTimers.current = [];
  };

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
    setTesting(false);
    setTestChannel(null);
    void refreshDevices();
    return clearTestTimers;
  // Refresh once per open; selection changes are made in this dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) {
      setBusy(true);
      setError(null);
      const stopForRoutingChange = async () => {
        try {
          const current = await playerStatus();
          resumeFromBeginningOnClose.current = current.loaded && current.playing;
          onPlayerStatusChange(current);
          // Stop (rather than pause) so a later resume starts at the loop start.
          if (current.loaded) onPlayerStatusChange(await playerStop());
        } catch (cause) {
          setError(String(cause));
        } finally {
          setBusy(false);
        }
      };
      void stopForRoutingChange();
      return;
    }
    const shouldResume = resumeFromBeginningOnClose.current;
    resumeFromBeginningOnClose.current = false;
    if (shouldResume) playerPlay().then(onPlayerStatusChange).catch(() => {});
  // Capture only whether playback was active; never retain its position.
  }, [open, onPlayerStatusChange]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const poll = () => {
      playerStatus().then((status) => {
        if (!active) return;
        setOutputLevels({
          left: status.playing || testing ? status.output_left_level_pct : 0,
          right: status.playing || testing ? status.output_right_level_pct : 0,
        });
        onPlayerStatusChange(status);
      }).catch(() => {});
    };
    poll();
    const interval = window.setInterval(poll, 100);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [open, onPlayerStatusChange, testing]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === deviceName),
    [devices, deviceName],
  );
  const systemDefault = devices.find((device) => device.is_default);
  const selectedAvailable = deviceName ? Boolean(selectedDevice) : Boolean(systemDefault);
  const activeDevice = deviceName ? selectedDevice : systemDefault;
  const channelCount = activeDevice?.channels ?? 0;
  const pairCount = Math.floor(channelCount / 2);
  const sampleRates = activeDevice?.sample_rates ?? [];
  const bufferPresets = [64, 128, 256, 512, 1024, 2048, 4096]
    .filter((frames) => activeDevice?.buffer_size_min != null
      && activeDevice.buffer_size_max != null
      && frames >= activeDevice.buffer_size_min
      && frames <= activeDevice.buffer_size_max);

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

  const testPair = async () => {
    setBusy(true);
    setTesting(true);
    setError(null);
    clearTestTimers();
    setTestChannel(null);
    const next = currentSelection();
    try {
      await audioTestOutput(next);
      onOutputTestStarted();
      saveSelection(next);
      setTestChannel("left");
      testTimers.current = [
        window.setTimeout(() => setTestChannel("right"), 400),
        window.setTimeout(() => {
          setTestChannel(null);
          setTesting(false);
          setBusy(false);
        }, 900),
      ];
    } catch (cause) {
      resumeFromBeginningOnClose.current = false;
      setError(String(cause));
      setTesting(false);
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
          <button onClick={onClose} disabled={busy} className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-border hover:text-text disabled:opacity-40">Close</button>
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

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block text-xs text-text-secondary">
            Device sample rate
            <select
              value={sampleRate}
              onChange={(event) => setSampleRate(event.target.value)}
              disabled={loading || busy || !selectedAvailable}
              className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
            >
              <option value="">Device default</option>
              {sampleRate && !sampleRates.includes(Number(sampleRate)) && (
                <option value={sampleRate}>Saved {Number(sampleRate) / 1000} kHz (unsupported)</option>
              )}
              {sampleRates.map((rate) => (
                <option key={rate} value={rate}>{(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-text-secondary">
            Buffer size
            <select
              value={bufferFrames}
              onChange={(event) => setBufferFrames(event.target.value)}
              disabled={loading || busy || !selectedAvailable}
              className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
            >
              <option value="">Device default</option>
              {bufferFrames && !bufferPresets.includes(Number(bufferFrames)) && (
                <option value={bufferFrames}>Saved {bufferFrames} frames</option>
              )}
              {bufferPresets.map((frames) => (
                <option key={frames} value={frames}>{frames} frames</option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-4 block text-xs text-text-secondary">
          Stereo output pair
          <select
            value={firstChannel}
            onChange={(event) => setFirstChannel(Number(event.target.value))}
            disabled={loading || busy || !selectedAvailable || channelCount < 2}
            className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50"
          >
            {Array.from({ length: pairCount }, (_, index) => (
              <option key={index} value={index * 2}>Output {index * 2 + 1}–{index * 2 + 2}</option>
            ))}
          </select>
        </label>

        <p className={`mt-2 text-[10px] ${selectedAvailable && channelCount >= 2 ? "text-success" : "text-danger"}`} role="status">
          {loading
            ? "Checking audio outputs…"
            : selectedAvailable && channelCount >= 2
              ? `${deviceName ? selectedDevice?.name : systemDefault?.name} available · ${channelCount} output channels`
              : !selectedAvailable
                ? deviceName ? "Selected device is disconnected. Refresh or choose another output." : "No system-default output is available."
                : "Selected device does not expose a stereo output pair."}
        </p>

        <p className="mt-3 text-[10px] text-text-secondary">
          Test plays a 440 Hz tone on L, then 660 Hz on R. The device opens with the selected sample rate and buffer size; “Device default” leaves those choices to the audio device.
        </p>
        <div className="mt-3 space-y-1.5" aria-label="Digital output levels">
          {([ ["L", outputLevels.left], ["R", outputLevels.right] ] as const).map(([channel, level]) => {
            const percent = Math.max(0, Math.min(100, level));
            return (
              <div key={channel} className="grid grid-cols-[1rem_1fr_2.5rem] items-center gap-2 text-[10px]">
                <span className="font-mono text-text-secondary">{channel}</span>
                <div
                  role="meter"
                  aria-label={`${channel} digital output level`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                  className="h-2 overflow-hidden rounded bg-border"
                >
                  <div className="h-full rounded bg-accent transition-[width] duration-75" style={{ width: `${percent}%` }} />
                </div>
                <span className="text-right tabular-nums text-text-secondary">{Math.round(percent)}%</span>
              </div>
            );
          })}
        </div>
        <p className="mt-1 text-[9px] text-text-secondary">Digital signal sent by oLooper before the audio interface; this is not a hardware loopback meter.</p>
        {testChannel && (
          <div className="mt-3 flex items-center gap-2 rounded border border-border bg-elevated px-3 py-2 text-[10px]" role="status" aria-live="polite">
            <span className={`h-2 w-2 rounded-full ${testChannel === "left" ? "bg-accent" : "bg-border"}`} />
            <span className="text-text-secondary">L</span>
            <span className={`h-2 w-2 rounded-full ${testChannel === "right" ? "bg-accent" : "bg-border"}`} />
            <span className="text-text-secondary">R</span>
            <span className="ml-1 text-text">Testing {testChannel === "left" ? "left" : "right"} channel…</span>
          </div>
        )}
        {(error || startupError) && <p className="mt-3 text-xs text-danger" role="alert">{error || startupError}</p>}

        <footer className="mt-5 flex items-center justify-between">
          <button onClick={() => void refreshDevices()} disabled={loading || busy} className="rounded bg-border px-3 py-2 text-[10px] text-text-secondary hover:text-text disabled:opacity-40">
            {loading ? "Refreshing…" : "Refresh devices"}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => void testPair()} disabled={loading || busy || !selectedAvailable || channelCount < 2 || firstChannel + 2 > channelCount} className="rounded bg-accent/15 px-3 py-2 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40">
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
