# FreeScratch promotional video

## Goal

Produce an independent promotional film for oLooper using the complete supplied
`promo/FreeScratch.mp3` (approximately 79.47 decoded seconds), with music-driven
motion and authentic product imagery.

## Deliverables

- Standalone browser player in `promo/`, without adding frontend dependencies.
- Nine editorial chapters: identity, kinetic hook, import, library, waveform,
  practice, MIDI, product overview and closing brand.
- Real screenshots from `docs/screenshots/`, projected with perspective.
- Show the actual app from frame zero and throughout the early kinetic hook.
- No persistent video header, footer, chapter counter or soundtrack credits.
- 1920 × 1080 output; music included in downloadable browser recordings.
- Deterministic 30 fps H.264/AAC MP4 master via optional Playwright/FFmpeg tooling.
- Storyboard, local preview instructions and regeneration steps in `promo/guion.md`.
- Generated master under the existing gitignored `dist/` directory.

## Audio and timing

- Preserve full track duration, pitch and musical ending.
- Analyze energy, bass, transients, approximate tempo, phase and waveform offline.
- Snap chapter cuts to nearby transients; use audio-clock timestamps for playback.
- Cache FFT spectrum frames at 30 Hz so offline renders and preview use the same
  measured musical data.
- Use brief edge fades only; no synthesized backing track or added voice.

## Player behavior

- Play/pause, seek, restart, fullscreen and monitor mute.
- Monitor mute must not silence recorded audio.
- Browser export starts at zero regardless of preview position.
- A hidden tab cancels recording rather than producing a frozen-frame result.
- Provide a persistent download link after export and codec fallback.
- Permit explicit MP3 selection when opened directly; recommend the loopback-only
  server for full same-origin preview/export support.

## Verification

- Synthetic known-tempo and silence regression tests for the audio analyzer.
- Browser review of all chapters, pause/seek/resume and full recording.
- Decode the generated master completely; verify duration, dimensions, frame
  rate, video codec and stereo audio stream.
