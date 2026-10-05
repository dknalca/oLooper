# ADR 0012: Selectable audio output and stereo channel pair

## Status

Accepted

## Context

oLooper needs explicit multichannel routing for DJ interfaces. Rodio 0.20's
`OutputStream::try_from_device_config` may fall back to a different supported
configuration after an open failure, without returning the actual configuration
it opened. A fallback from a multichannel stream to stereo can route audio to a
different physical destination. Rodio's Sink queue initially describes itself
as mono; changing channel layouts while it is queued can also leak audio into
unselected outputs when Rodio converts/resamples for a multichannel mixer.

## Decision

- Enumerate output devices and supported channels, sample rates, sample formats,
  and buffer ranges through CPAL.
- Keep the system default as the initial selection; allow an explicit device
  override, an even zero-based first channel for the stereo pair, an optional
  supported sample rate, and an optional buffer frame count.
- Build the CPAL stream directly with the chosen `StreamConfig` and sample
  format. Do not allow Rodio to silently fall back to another device config.
- Use Rodio's mixer/Sink for decoded sources. Wrap each Sink queue with its
  stable source channel count and source sample rate. Rodio converts and
  resamples sources into a two-channel mixer at the selected device rate; the
  CPAL callback then maps that stereo bus to the selected hardware pair and
  zeros all other channels.
- Default to the device's default sample rate and buffer. Explicit
  sample rates and buffers are chosen only from the device's advertised ranges.
- Serialize setting changes through the existing audio engine command queue.
- Persist the active device and each device's stereo-pair choice in frontend
  local storage, not the audio catalog; persist sample-rate and buffer
  selections with the active device preference.

## Consequences

- Output changes can preserve the current track and transport state while
  recreating the stream.
- The built-in left/right tone test uses the same routed source as playback,
  pauses the track while the dialog is open, and resumes it from loop start on
  close only when playback was active at dialog entry.
- L/R meters are digital peak measurements in the routed source before the
  hardware interface; no analog loopback is implied.
- After the library root is initialized, timestamped audio diagnostics are
  persisted under `<library>/log/`, including OS and host architecture (and
  Rosetta state on macOS), device capabilities and stream choices, and
  output-test levels. Logs omit
  track names and source paths and are capped by rotating at 2 MiB. The
  real-time sample callback never writes to disk.
- The CPAL callback only pulls prepared stereo Rodio-mixer samples, applies the
  physical channel mapping and digital peak metering, and converts to the
  selected device sample format. Decoding remains outside the callback.
- Device names are used as selection identifiers because CPAL 0.15 does not
  expose stable cross-session device IDs. If an interface is renamed or
  disconnected, the user can select another device or return to system default.
- When system default is selected, the engine checks the host default endpoint
  periodically and reopens the stream if its name changes. Explicit endpoint
  selections remain pinned.
- Windows device enumeration and stream creation have been exercised on a
  Windows 11 machine; switching a physical output and macOS routing remain
  manual hardware acceptance tests. CI covers channel mapping without requiring
  an audio device.
