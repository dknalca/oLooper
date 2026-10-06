# 150 — Routed practice metronome

## Scope

Add a compact metronome control to the top toolbar. It follows the active
track's BPM when a new track is selected, can be adjusted manually from 30 to
300 BPM, and defaults to 120 BPM when the track has no BPM.

## User-visible behavior

- Start/stop the metronome without changing track playback state.
- The first beat of each four-beat bar is accented.
- The metronome panel animates a four-beat visual indicator with an accented
  downbeat.
- Adjusting the control while running changes the click tempo immediately.
- The click uses oLooper's selected audio device and stereo output pair; it is
  mixed independently from track volume, speed, looping, and pitch lock.
- Changing output devices preserves the metronome setting. During the audio
  output test, pause the click and resume it afterward only if it was running.
- The metronome is off after app restart; its on/off state is not persisted.

## Acceptance criteria

- [ ] Toolbar controls start/stop the click and accept BPM values from 30–300.
- [ ] Selecting a track with BPM updates the running metronome; selecting a
  track without BPM uses 120 BPM.
- [ ] Click timing and four-beat accent pattern are covered by hardware-free
  tests; invalid tempo values are rejected.
- [ ] The visual beat indicator advances at the selected BPM and highlights the
  accented first beat.
- [ ] Track playback controls, speed changes, and volume do not alter the
  metronome; selected device/channel routing applies to it.
- [ ] Output reconfiguration and output test preserve metronome run/pause state.

## Non-goals

- Recording, tap-tempo, time signatures other than 4/4, or visual beat-grid
  synchronization to the decoded track.
