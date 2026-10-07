# Release notes

## 0.6.4

- Fix the Pitch speed control so tempo and pitch change immediately during
  playback, before output-mixer sample-rate conversion.
- Keep Pitch Lock hidden; the **Pitch** label remains beside the 50–200% control.
- Refresh the README screenshots with the current library, audio-output, and MIDI views.

## 0.6.3

- Ask for the import mode each time SWF/EXE files are selected or dropped:
  extract their audio or play directly from the managed source copy.
- Restore the **PITCH LOCK** toggle beside the pitch/speed control.
- Confirm looper removal in an in-app dialog that lists the managed SWF/EXE,
  extracted/downloaded audio, and cover files that may be removed.
- Delete managed container copies and extracted audio when removing the final
  referencing looper, while preserving original files outside the library.
- Fix deletion for groups containing both extracted and source-backed tracks;
  restore staged files if catalog deletion fails.
- Expand regression tests for SWF/EXE playback and removal, and add Windows CI
  coverage for x64 tests and installer generation.

## 0.6.2

- Fixed **Reveal audio file** on Windows: files are selected in Explorer and
  folders open directly, including paths canonicalized with the Windows
  extended-length prefix.

## 0.6.1

- Fixed looper selection on Windows when pointer capture is active for sidebar
  reordering; clicking a looper opens its tracks again.

## 0.6.0

- Added an **ALL** collection, ordered playlists, and persistent looper ordering.
- Added a routed four-beat metronome and an immediate **Next random** practice
  control.
- Improved BPM confidence reporting and added review prompts for uncertain
  estimates.
- Added on-demand conversion of managed WAV loops to verified 320 kbps MP3.
- Added macOS drag-out copies for library audio and expanded internal drag-and-
  drop targets.
- Added a startup intro with a rotating selection of scratcher quotes.
- Migrates existing libraries through SQLite schema version 8 without copying
  audio into playlists.

### Downloads

- macOS: Universal 2 unsigned DMG for Intel and Apple silicon.
- Windows: x64 NSIS installer, built from the `v0.6.0` tag using the Windows
  release workflow.

The macOS DMG and Windows installer are unsigned. macOS Gatekeeper and Windows
SmartScreen may show first-launch prompts.
