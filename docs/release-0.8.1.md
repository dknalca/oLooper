# oLooper v0.8.1

## Highlights

- Reduce avoidable catalog, cover and player-status work with bounded reuse,
  short-lived file observations and shared periodic polling. Random playback
  hydrates only selected candidates; waveform scans cooperatively stop when their
  playback owner becomes obsolete.
- Transfer owned decode inputs where possible and reuse buffers during audio
  preparation without changing DSP, playback samples or output behavior.
- Break complex UI flows into focused components and hooks, backed by regression
  tests for playback, imports, library navigation, audio routing and waveforms.
- Include a portable Rane 72 MIDI preset recovered from the saved controller map.
  It contains 11 Rane controls and excludes two controls belonging to a separate
  MIDI pad device. Device-local IDs are not included. Existing empty built-in
  templates refresh; customized presets and active assignments are preserved.
- Include the standalone FreeScratch promotional preview and rendering source.

## Validation

- 348 frontend tests passed; TypeScript check and production frontend build passed.
- 301 Rust tests passed; four fixture-dependent tests were ignored. Rust formatting
  check passed.
- Automated and headless tests are not physical audio/MIDI-device validation.
  macOS Universal 2 and Windows x64 release packages are built by GitHub Actions.

## Compatibility

- The catalog remains at schema v11; this release adds no database migration.
  v0.8.0 and v0.8.1 can use the same upgraded library. As before, app versions
  older than v0.8.0 cannot open a library migrated to schema v11.
- The macOS package remains intentionally unsigned and unnotarized. See the
  README installation and Gatekeeper instructions.
