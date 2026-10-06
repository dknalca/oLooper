# ADR 0016 — Render the metronome through oLooper's routed mixer

- Status: accepted
- Date: 2026-10-06

## Context

The app can route audio to a selected hardware device and stereo pair. A
frontend-generated click could use a different system output and would not
follow that routing.

## Decision

- Generate a bounded four-beat PCM click buffer in the Rust audio engine and
  play it through the existing stereo mixer and routed CPAL output stream.
- Keep metronome transport separate from the track sink so play, pause, stop,
  speed, pitch lock, and track volume do not control the click.
- Rebuild the click sink on output-route changes. Pause it for the temporary
  L/R output test and resume only if it was running beforehand.
- Do not persist metronome enabled state across app restarts.

## Consequences

- The click follows the selected output device and stereo pair without a
  separate audio API or stream.
- Hardware-free tests can verify tempo buffer bounds, beat spacing, and bar
  accents independently of CoreAudio hardware.
