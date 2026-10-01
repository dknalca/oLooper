# ADR 0012: Selectable audio output and stereo channel pair

## Status

Accepted

## Context

oLooper's Rodio output stream used the system's default device and default
stream configuration. That is insufficient for multichannel DJ interfaces,
where the desired cue/program signal may be connected to a stereo pair such as
outputs 2–3. The audio engine runs on a dedicated thread because Rodio stream
and sink objects are not `Send`.

## Decision

- Enumerate output devices and supported channel counts through CPAL.
- Keep the system default as the initial selection; allow an explicit device
  override and a zero-based first channel for the stereo pair.
- Use Rodio for stream and sink lifecycle, and route each mono/stereo source
  into a multichannel stream with silence on unselected channels.
- Serialize setting changes through the existing audio engine command queue.
- Persist the active device and each device's stereo-pair choice in frontend
  local storage, not the audio catalog.

## Consequences

- Output changes can preserve the current track and transport state while
  recreating the stream.
- The built-in left/right tone test uses the same routed source as playback,
  pauses the track while the dialog is open, and resumes it from loop start on
  close only when playback was active at dialog entry.
- L/R meters are digital peak measurements in the routed source before the
  hardware interface; no analog loopback is implied.
- Device names are used as selection identifiers because CPAL 0.15 does not
  expose stable cross-session device IDs. If an interface is renamed or
  disconnected, the user can select another device or return to system default.
- Hardware routing remains a manual macOS acceptance test; CI covers the
  channel mapping source without requiring an audio device.
