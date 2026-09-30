# 030 — Practice Player

## Scope

Practice playback for one loaded track: play/pause/stop, infinite loop over
the selected automatic region, track switching, volume, position reporting.
Waveform rendering and library integration are separate specs.

## User-visible behavior

1. Load a track (MP3, WAV, or supported M4A) → duration known, default loop =
   full track, paused at start, playback speed reset to 100%.
2. Play → audio starts; Pause freezes; Stop returns to loop start.
3. Loop enabled (default) → region repeats without reopening the file and
   without audible gaps beyond decoder/buffer limits.
4. `AUTO` detects and snaps a suitable loop region from audio. The player UI
   exposes loop enable/disable and automatic detection; manual boundary editing
   is not exposed.
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
   and L (loop toggle). Previous/next transport buttons move through the
   tracks shown in the selected library view. Loop enablement, AUTO detection,
   and manual boundaries are in the collapsible Loop controls panel. PITCH LOCK
   remains hidden.
8. The transport labels the saved slot buttons with **CUE**. Cues `1`–`4`:
    cue `1` always seeks to the track start. Cues `2`–`4` start empty, capture
    the current playback position on first click, seek on later clicks, can be
    cleared with Shift+cue, and are drawn on the waveform.
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
12. Practice time accumulates only while audio is playing and can be reset
    from the top bar. Optional random mode switches to another playable local
    library track at 2-minute, 5-minute, or custom (1–1440 minute) intervals;
    the timer repeats until disabled and avoids the current track when possible.
13. The waveform shows the current track name in its upper-left corner.
14. Audio output follows the system default unless a device and stereo output
    pair are selected in **oLooper → Audio Output…**. For multichannel devices,
    decoded mono is duplicated to the chosen pair and stereo is routed left and
    right to that pair; all other output channels are silent. Changing the
    selection applies immediately and restarts current playback at its current
    frame without changing track, loop, speed, volume, or play/pause state.
    The selection persists locally across launches. See spec 120.

## Supported inputs

- Files rodio/Symphonia can decode (MP3, WAV, and Tablist AAC/M4A). M4A playback
  trims up to 150 ms of near-zero AAC padding at either edge; other formats are intact.
  Undecodable → typed error, previous track (if any) keeps its state.

## Outputs

- `player_status`: `{ loaded, playing, position_ms, duration_ms,
  loop_start_ms, loop_end_ms, loop_enabled, volume, speed_pct, pitch_lock,
  pitch_preparing, pitch_error, loading, load_error }`.

## Failure behavior

- No output device → clear error at first play attempt, nothing half-started.
- A disconnected selected device or unavailable channel pair reports an error
  and leaves the previous output and playback state intact.
- Decode failure → error; the source file remains untouched.
- All player errors user-facing; no panics on bad ms values (clamped).

## Persistence behavior

- Playback position, playback speed, pitch-lock state, practice time, and random
  timer settings are session-only. Speed and pitch lock reset to defaults on each track.
  Per-track BPM and cue/loop slots persist in the library (`010`, `070`).

## Platform considerations

- rodio backend (ADR 0002): perceptually gapless, latency not guaranteed. Input
  files are capped at 512 MiB and 15 minutes. The decoded-track cache is bounded
  to 128 MiB and six tracks.

## Security implications

- Path inputs are backend-read with the 512 MiB cap; no shell-out.
  Decoders run on untrusted bytes — Symphonia/rodio only, no custom codecs.

## Acceptance criteria

- [x] Load → play → loop wraps N times with no reopen and no drift
  (position advances monotonically modulo region).
- [x] Pause/resume keeps sample-accurate region position.
- [x] AUTO chooses a snapped frame-precise loop candidate when one qualifies.
- [x] Unit tests cover wrap math + a synthetic WAV end-to-end (no hardware).
- [x] Manual: an extracted loop from `loopersFlash/` plays and loops audibly.
- [x] Keyboard shortcuts control transport without mouse.
- [x] CUE 1–4 recall/save as documented; saved cues 2–4 persist per track.
- [x] Loading another track resets playback speed to 100%.
- [ ] Stereo output can follow the system default or route to any supported
  stereo channel pair on a selected device.

## Non-goals

- Gapless sample-exact looping, playlists/queue, pitch/tempo, seeking while
  looping with sub-buffer precision, persistence, visualization.
