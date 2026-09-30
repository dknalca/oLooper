# 120 — Audio Output Routing

## Scope

Let the user choose between the current system-default audio output and an
available output device with a specific stereo channel pair. This supports
multichannel DJ interfaces whose mixer channels are connected to output pairs
other than 1–2.

## User-visible behavior

1. **oLooper → Audio Output…** opens device and stereo-pair selectors.
2. System default is the initial setting and follows the default output chosen
   in macOS. Selecting a device overrides that default for oLooper only.
3. Available stereo pairs are derived from the device's supported output
   channel count. Pair labels use one-based channel numbers (for example,
   Output 2–3).
4. Mono audio is duplicated to both channels of the selected pair. Stereo audio
   routes left/right to that pair; every other output channel is silent.
5. Applying a new route reconnects the audio stream and, if a track is loaded,
   resumes the same playback state at the current frame. Track, loop, speed,
   pitch lock, and volume are preserved.
6. The selected device name and first channel are stored in local app settings.
   A missing saved device is reported when applying settings; playback can use
   the system default instead.

## Failure behavior

- Device enumeration failures are shown in the dialog.
- A disconnected device, unsupported channel pair, or stream creation error
  leaves the existing stream and selection active.
- The audio engine remains lazy; opening the dialog or selecting a setting does
  not require creating an output stream until playback starts.

## Implementation

- CPAL enumerates devices and their supported output channel counts.
- Rodio owns the output stream and sink. A channel-routing source places the
  practice player's mono/stereo samples at the chosen output indices.
- The frontend invokes output commands through `src/tauri.ts`; the backend
  applies routing on the existing audio engine thread.

## Acceptance criteria

- [x] Hardware-free regression tests verify stereo and mono channel mapping.
- [ ] Manual on macOS: system-default output follows the selected system route.
- [ ] Manual on macOS: a DJ interface routes to a non-1–2 stereo pair.
- [ ] Changing outputs while paused/playing preserves transport state.
