import type { audioDeviceOptions } from "../audioDeviceOptions";

interface Props {
  deviceName: string;
  options: ReturnType<typeof audioDeviceOptions>;
  loading: boolean;
  busy: boolean;
  sampleRate: string;
  bufferFrames: string;
  firstChannel: number;
  onSampleRate: (value: string) => void;
  onBufferFrames: (value: string) => void;
  onFirstChannel: (value: number) => void;
}

/** Output options and availability; applying a route remains in the dialog. */
export default function AudioOutputControls({ deviceName, options, loading, busy, sampleRate, bufferFrames, firstChannel, onSampleRate, onBufferFrames, onFirstChannel }: Props) {
  const { selectedDevice, systemDefault, selectedAvailable, channelCount, pairCount, sampleRates, bufferPresets } = options;
  return <>
    <div className="mt-4 grid grid-cols-2 gap-3">
      <label className="block text-xs text-text-secondary">Device sample rate
        <select value={sampleRate} onChange={(event) => onSampleRate(event.target.value)} disabled={loading || busy || !selectedAvailable} className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50">
          <option value="">Device default</option>
          {sampleRate && !sampleRates.includes(Number(sampleRate)) && <option value={sampleRate}>Saved {Number(sampleRate) / 1000} kHz (unsupported)</option>}
          {sampleRates.map((rate) => <option key={rate} value={rate}>{(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz</option>)}
        </select>
      </label>
      <label className="block text-xs text-text-secondary">Buffer size
        <select value={bufferFrames} onChange={(event) => onBufferFrames(event.target.value)} disabled={loading || busy || !selectedAvailable} className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50">
          <option value="">Device default</option>
          {bufferFrames && !bufferPresets.includes(Number(bufferFrames)) && <option value={bufferFrames}>Saved {bufferFrames} frames</option>}
          {bufferPresets.map((frames) => <option key={frames} value={frames}>{frames} frames</option>)}
        </select>
      </label>
    </div>
    <label className="mt-4 block text-xs text-text-secondary">Stereo output pair
      <select value={firstChannel} onChange={(event) => onFirstChannel(Number(event.target.value))} disabled={loading || busy || !selectedAvailable || channelCount < 2} className="mt-1 block w-full rounded border border-border bg-elevated px-2 py-2 text-xs text-text disabled:opacity-50">
        {Array.from({ length: pairCount }, (_, index) => <option key={index} value={index * 2}>Output {index * 2 + 1}–{index * 2 + 2}</option>)}
      </select>
    </label>
    <p className={`mt-2 text-[10px] ${selectedAvailable && channelCount >= 2 ? "text-success" : "text-danger"}`} role="status">
      {loading ? "Checking audio outputs…" : selectedAvailable && channelCount >= 2
        ? `${deviceName ? selectedDevice?.name : systemDefault?.name} available · ${channelCount} output channels`
        : !selectedAvailable
          ? deviceName ? "Selected device is disconnected. Refresh or choose another output." : "No system-default output is available."
          : "Selected device does not expose a stereo output pair."}
    </p>
  </>;
}
