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
   The dialog shows device availability and the number of output channels;
   disconnected saved devices can be refreshed or replaced.
4. Mono audio is duplicated to both channels of the selected pair. Stereo audio
    routes left/right to that pair; every other output channel is silent.
5. Opening Audio Output stops an active track at the loop start. Applying a new
   route reconnects the stream while stopped. Closing the dialog starts the
   loaded track from the loop start only if it was playing on entry; a track
   that was paused on entry stays paused. Track, loop, speed, pitch lock, and
   volume are preserved.
6. **Test L/R** sends a short, moderate-volume 440 Hz tone to the left channel,
    then a 660 Hz tone to the right channel. It applies the selected route,
    temporarily takes the routed stream for the test. Track playback is stopped
    for the entire dialog; closing resumes from loop start only if playback was
    active when the dialog opened.
7. The selected device and its stereo pair are remembered independently for each
    device in local app settings.
   A missing saved device is reported when applying settings; playback can use
   the system default instead.
8. The dialog displays whether the selected device is available, its supported
   output-channel count, and digital L/R peak levels. These meter values are
   measured before the interface and do not claim to sense its physical outputs.

## Failure behavior

- Device enumeration failures are shown in the dialog.
- A disconnected device, unsupported channel pair, or stream creation error
  leaves the existing stream and selection active.
- The test signal is canceled safely when its stream ends; the transport resumes
  only if it was active when the test began.
- Digital L/R meters report the signal oLooper sends, not analog/interface
  loopback levels.
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
- [x] The generated test signal sends left and right tones on separate sides.
- [x] Unit tests verify output tests preserve transport pause/resume intent.
- [x] The frontend remembers channel pairs independently per output device.
- [x] The dialog shows device availability, channel count, and routed digital
  L/R peak levels.
- [ ] Manual on macOS: system-default output follows the selected system route.
- [ ] Manual on macOS: a DJ interface routes to a non-1–2 stereo pair.
- [ ] Opening/closing output settings follows the documented stop-and-restart behavior.
