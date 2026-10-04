# 120 — Audio Output Routing

## Scope

Let the user choose between the current system-default audio output and an
available output device with a specific stereo channel pair. This supports
multichannel DJ interfaces whose mixer channels are connected to output pairs
other than 1–2.

## User-visible behavior

1. **oLooper → Audio Output…** opens device, stereo-pair, sample-rate and
   buffer-size selectors.
2. System default is the initial setting and follows the default output chosen
   in macOS. Selecting a device overrides that default for oLooper only.
3. Available stereo pairs are derived from the device's supported output
   channel count. Pair labels use one-based channel numbers (Output 1–2,
   Output 3–4, etc.). Overlapping pairs such as 2–3 are not valid stereo
   outputs; old saved odd selections fall back to the preceding complete pair.
   The dialog shows device availability and the number of output channels;
   disconnected saved devices can be refreshed or replaced.
4. Sample rate can follow the device default or use one of its advertised rates.
   Buffer size can remain at CoreAudio's default or use a frame count inside the
   selected device's advertised range. Unsupported combinations return an error
   without replacing the current stream.
5. Mono audio is duplicated to both channels of the selected pair. Stereo audio
    routes left/right to that pair; every other output channel is silent.
6. Opening Audio Output stops an active track at the loop start. Applying a new
   route reconnects the stream while stopped. Closing the dialog starts the
   loaded track from the loop start only if it was playing on entry; a track
   that was paused on entry stays paused. Track, loop, speed, pitch lock, and
   volume are preserved.
7. **Test L/R** sends a short, moderate-volume 440 Hz tone to the left channel,
    then a 660 Hz tone to the right channel. It applies the selected route,
    temporarily takes the routed stream for the test. Track playback is stopped
    for the entire dialog; closing resumes from loop start only if playback was
    active when the dialog opened.
8. The selected device and its stereo pair are remembered independently for each
    device in local app settings.
   A missing saved device is reported when applying settings; playback can use
   the system default instead.
9. The dialog displays whether the selected device is available, its supported
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

- CPAL enumerates devices and their supported channel counts, sample rates,
  sample formats, and buffer sizes, then opens the selected stream directly.
- Rodio's Sink queues feed a two-channel mixer at the selected device rate.
  Each queue advertises its stable source channel count and source sample rate
  from creation; its initial silence source is mono, so changing metadata after
  samples are queued could trigger unwanted channel conversion.
- Rodio converts/resamples source PCM into the stereo mixer before physical
  routing. The CPAL callback places those two samples at the selected hardware
  pair and zeros every other output channel. This keeps Rodio's channel
  conversion out of the multichannel hardware layout.
- An explicitly selected multichannel interface opens its full-channel stream
  even for Output 1–2. Opening the device's default stereo stream instead may
  select a different hardware destination, such as a mixer master bus.
- CPAL's chosen channel count, sample rate, sample format and buffer size are used
  directly to open the stream. Rodio is not allowed to silently fall back to a
  different output configuration. Track PCM stays at its decoded rate until
  Rodio's sample-rate converter feeds the chosen device rate.
- The CPAL callback only pulls ready stereo samples from Rodio's mixer, maps
  them to the selected pair, updates digital peak meters, and converts their
  sample format; decoding and file I/O stay outside it.
- The frontend invokes output commands through `src/tauri.ts`; the backend
  applies routing on the existing audio engine thread.

## Acceptance criteria

- [x] Hardware-free regression tests verify stereo and mono channel mapping.
- [x] A 44.1 kHz track rendered through Sink, Rodio's queue/mixer and 48 kHz
  resampling produces zero samples on all unselected DJM-S11 output channels.
- [x] The selector exposes only complete stereo pairs; the backend rejects
  overlapping pairs that straddle two hardware outputs.
- [x] Device sample rate and CoreAudio buffer can be selected or left at their
  advertised defaults; incompatible requests are rejected.
- [x] The opened CPAL stream uses its selected channel count/sample format and
  has no hidden Rodio device-configuration fallback.
- [x] The generated test signal sends left and right tones on separate sides.
- [x] Unit tests verify output tests preserve transport pause/resume intent.
- [x] The frontend remembers channel pairs independently per output device.
- [x] The dialog shows device availability, channel count, and routed digital
  L/R peak levels.
- [ ] Manual on macOS: system-default output follows the selected system route.
- [ ] Manual on macOS: a DJ interface routes to a non-1–2 stereo pair.
- [ ] Opening/closing output settings follows the documented stop-and-restart behavior.
