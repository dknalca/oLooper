import type { AudioOutputDevice } from "./tauri";

const BUFFER_PRESETS = [64, 128, 256, 512, 1024, 2048, 4096];

/** Derive selectable output capabilities without changing the saved selection. */
export function audioDeviceOptions(devices: AudioOutputDevice[], deviceName: string) {
  const selectedDevice = devices.find((device) => device.id === deviceName);
  const systemDefault = devices.find((device) => device.is_default);
  const selectedAvailable = deviceName ? Boolean(selectedDevice) : Boolean(systemDefault);
  const activeDevice = deviceName ? selectedDevice : systemDefault;
  const channelCount = activeDevice?.channels ?? 0;
  const bufferPresets = BUFFER_PRESETS.filter((frames) => activeDevice?.buffer_size_min != null
    && activeDevice.buffer_size_max != null
    && frames >= activeDevice.buffer_size_min
    && frames <= activeDevice.buffer_size_max);
  return {
    selectedDevice, systemDefault, selectedAvailable, channelCount,
    pairCount: Math.floor(channelCount / 2), sampleRates: activeDevice?.sample_rates ?? [], bufferPresets,
  };
}
