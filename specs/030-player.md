# 030 — Practice Player

## Scope

Practice playback for one loaded track: play/pause/stop, infinite loop over
an editable region, track switching, volume, position reporting.
Waveform rendering and library integration are separate specs.

## User-visible behavior

1. Load a track (extracted MP3, WAV) → duration known, default loop = full
   track, paused at start.
2. Play → audio starts; Pause freezes; Stop returns to loop start.
3. Loop enabled (default) → region repeats without reopening the file and
   without audible gaps beyond decoder/buffer limits.
4. User edits loop start/end in ms → takes effect immediately, clamped to
   `[0, duration]`, start < end enforced.
5. Switch track → old audio stops hard, new track loads paused at its start.
6. Volume 0–100%. Position display follows playback (~poll 4 Hz; native layer
   authoritative, UI only polls — buffer latency accepted in MVP).
7. Keyboard shortcuts (spec 060): Space (play/pause), S (stop), arrows (seek),
   L (loop toggle), [ / ] (set loop start/end).
8. Loop slots (spec 070): A–D buttons in player; click empty to save, click
   filled to load. Auto-loads slot A on track load.
9. `+` and `-` change playback speed in 5% steps from 50% to 200%. This is
   vinyl-style playback, so pitch changes with speed. The visible pitch-lock
   control is disabled until the audio engine gains portable time-stretching.

## Supported inputs

- Files rodio/Symphonia can decode (MP3 incl. extractor output, WAV).
  Undecodable → typed error, previous track (if any) keeps its state.

## Outputs

- `player_status`: `{ loaded, playing, position_ms, duration_ms,
  loop_start_ms, loop_end_ms, loop_enabled, volume }`.

## Failure behavior

- No output device → clear error at first play attempt, nothing half-started.
- Decode failure → error with path + "file left untouched" note.
- All player errors user-facing; no panics on bad ms values (clamped).

## Persistence behavior

- None in this spec (no cue/loop persistence yet — that is library work).
  Loaded path + loop region live only in session state.

## Platform considerations

- rodio backend (ADR 0002): perceptual gapless, latency not guaranteed.
  Decode-on-load holds one track in memory (f32 interleaved); a 5-min stereo
  44.1 kHz track ≈ 100 MB worst case — acceptable for practice loops, and a
  documented limit (files > 15 min rejected with a clear message).

## Security implications

- Path inputs are backend-read with the 512 MiB cap; no shell-out.
  Decoders run on untrusted bytes — Symphonia/rodio only, no custom codecs.

## Acceptance criteria

- [x] Load → play → loop wraps N times with no reopen and no drift
  (position advances monotonically modulo region).
- [x] Pause/resume keeps sample-accurate region position.
- [x] Loop edits clamp; start ≥ end rejected with message.
- [x] Unit tests cover wrap math + a synthetic WAV end-to-end (no hardware).
- [x] Manual: an extracted loop from `loopersFlash/` plays and loops audibly.
- [x] Keyboard shortcuts control transport without mouse.
- [x] Loop slots A–D save/load correctly; auto-load slot A on track load.

## Non-goals

- Gapless sample-exact looping, playlists/queue, pitch/tempo, seeking while
  looping with sub-buffer precision, persistence, visualization.
