# Release notes

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
