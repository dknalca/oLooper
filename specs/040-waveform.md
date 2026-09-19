# 040 — Waveform

## Scope

DJ-style waveform for the loaded track: scrolling display under a fixed
playhead, loop-region overlay, click-to-seek. Data comes from a backend peak
computation; rendering is canvas-only (no audio decoding per frame).

## User-visible behavior

1. Loading a track computes peaks once (backend); the waveform appears with
   the loop region shaded and a fixed center playhead.
2. During playback the waveform scrolls; position display stays in sync
   (native position polled at 4 Hz, UI interpolates between polls).
3. Click (or tap) on the waveform seeks there; looping continues per the
   enabled flag. Loop edits re-shade immediately.
4. Tracks shorter than the view window render whole; longer tracks render a
   ~30 s window around the position.

## Supported inputs

- Any `player_load`-compatible file. Peak requests carry a bucket count
  derived from canvas width (capped server-side).

## Outputs

- `waveform_peaks { peaks: f32[0..1] per bucket, duration_ms }`.

## Failure behavior

- Undecodable file → waveform area shows the loader error, player unaffected.
- Absurd bucket counts clamped (64–8192); no allocation on demand.

## Persistence behavior

- None in MVP: peaks recompute per load and live in frontend memory keyed by
  file path. Disk cache is explicit future work (format reserved, not built).

## Platform considerations

- Pure computation, no OS APIs. Canvas 2D everywhere; devicePixelRatio aware.

## Security implications

- Same read caps as playback (512 MiB). Output is aggregate floats only.

## Acceptance criteria

- [ ] Extracted loop shows shaped waveform (not flat, not noise) with loop
  overlay; playhead advances; scroll follows.
- [ ] Click seeks within ±1 bucket of the target; loop wrap keeps shading.
- [ ] Unit tests: synthetic WAV yields exact expected buckets; invalid input
  errors; bucket clamp holds.
- [ ] No per-frame decode: peaks computed once per path+bucket-count.

## Non-goals

- Multiresolution/frequency-colored waveform, beat markers, stems view,
  disk cache, pinch-zoom (fixed window + full-track fallback only).
