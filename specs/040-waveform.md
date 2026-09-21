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
5. The waveform occupies the upper fifth of the workspace. The transport,
   cue, loop and slot controls form a compact band immediately below it; the
   loop library uses all remaining vertical space.
6. Selecting a track loads playback first. Waveform analysis starts after a
   short idle delay, is cancelled when another track is selected, and must not
   delay selection or playback controls.
7. Waveform peaks reuse the PCM buffer decoded by the player. A track switch
   must not reread or decode the same audio file solely for waveform display.
8. Contention-free protocol: the request first tries the persistent disk
   cache (no engine lock at all on a hit). On a miss it clones the player's
   `Arc<LoopBuffer>` under a short read lock, releases the lock immediately,
   and computes peaks off-lock. Each job is tagged with path + load
   generation; after computing, the job re-checks the current generation and
   discards its result (`"track changed …"` error) if the user already
   selected another track. Peak computation never blocks track loading or
   transport.

## Supported inputs

- Any `player_load`-compatible file. Peak requests carry a bucket count
  derived from canvas width (capped server-side).

## Outputs

- `waveform_peaks { peaks: f32[0..1] per bucket, duration_ms }`.

## Failure behavior

- Undecodable file → waveform area shows the loader error, player unaffected.
- Absurd bucket counts clamped (64–8192); no allocation on demand.

## Persistence behavior

- Peaks are cached under the selected library's `.olooper-cache/waveforms/`
  directory. Cache keys include canonical path, file size, modification time,
  and bucket count, so replacing a track invalidates its prior waveform.
- Cache entries are derived data only, written atomically and capped by the
  existing bucket limit. Every request logs one `[olooper:metrics]` line
  with lookup/compute/store durations, lock waits, bucket count, audio
  shape, and cache hit/miss. The UI shows `Generating waveform…` while a
  miss computes. Missing, corrupt, or unwritable cache entries fall
  back to peak computation without affecting playback or source audio.

## Platform considerations

- Pure computation, no OS APIs. Canvas 2D everywhere; devicePixelRatio aware.

## Security implications

- Same read caps as playback (512 MiB). Output is aggregate floats only.

## Acceptance criteria

- [x] Extracted loop shows shaped waveform (not flat, not noise) with loop
  overlay; playhead advances; scroll follows.
- [x] Click seeks within ±1 bucket of the target; loop wrap keeps shading.
- [x] Unit tests: synthetic WAV yields exact expected buckets; invalid input
  errors; bucket clamp holds.
- [x] No per-frame decode: peaks computed once per path+bucket-count.

## Non-goals

- Multiresolution/frequency-colored waveform, beat markers, stems view,
  pinch-zoom (fixed window + full-track fallback only).
