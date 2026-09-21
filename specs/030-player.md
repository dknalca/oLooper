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
5. Switch track → the new row highlights immediately and a loading state is
   published; the previous audio keeps playing until the new decode proves
   valid. File read + decode run on a background worker tagged with a load
   generation. Only the latest requested generation is applied (older ones
   discarded); on decode error the previous track keeps playing and the
   error is exposed via status (`load_error`) without touching the old
   buffer. Waveform fetch waits for the new audio (path only changes on a
   valid swap) and never blocks interaction.
6. Volume 0–100%. Position display follows playback (~poll 4 Hz; native layer
   authoritative, UI only polls — buffer latency accepted in MVP). The UI
   also polls while `loading` or `pitch_preparing` is set.
7. Keyboard shortcuts (spec 060): Space (play/pause), S (stop), arrows (seek),
   L (loop toggle), [ / ] (set loop start/end).
8. Cues `1`–`4`: cue `1` always seeks to the track start. Cues `2`–`4` start
   empty, capture the current playback position on first click, seek on later
   clicks, can be cleared, and are drawn on the waveform.
9. `+` and `-` change playback speed in 5% steps from 50% to 200%. This is
   vinyl-style playback, so pitch changes with speed unless pitch lock is on.
10. Pitch lock is non-blocking: enabling it (or changing speed while locked)
   keeps the current audio playing untouched, publishes `pitch_preparing`,
   and stretches (WSOLA) on a background worker tagged with track
   generation + speed + job id. The stretched buffer is applied only if
   track, speed, pitch-lock state, and job still match — otherwise the
   result is discarded. Changing track/speed or disabling pitch lock
   supersedes the pending job. The displayed speed is never altered
   silently; WSOLA failures clear `pitch_preparing` and surface via
   `pitch_error` without changing lock state.
11. Observability (measure before changing behavior): background jobs log
   one `[olooper:metrics]` line each with durations for file read, decode,
   WSOLA stretch, waveform lookup/compute/store, and engine-lock waits,
   plus size, duration, sample rate, channels, speed %, and cache
   hit/miss. The UI shows `Loading audio…` (track row + transport) and
   `Preparing pitch lock…` while those jobs run.

## Supported inputs

- Files rodio/Symphonia can decode (MP3 incl. extractor output, WAV).
  Undecodable → typed error, previous track (if any) keeps its state.

## Outputs

- `player_status`: `{ loaded, playing, position_ms, duration_ms,
  loop_start_ms, loop_end_ms, loop_enabled, volume, speed_pct, pitch_lock,
  pitch_preparing, pitch_error, loading, load_error }`.

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
