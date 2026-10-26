# 220 — Modern workspace experience

## Scope

Refresh the desktop practice workspace with a consistent dark slate palette,
clearer surface hierarchy, readable secondary text, and visible focus states.

## Behavior

- Keep waveform, transport, and library in that order; use distinct rounded
  panels and allow toolbar and transport controls to wrap in narrower windows.
- Expose Audio, MIDI, and keyboard shortcuts directly in the header alongside
  import, library folder, metronome, and practice timer controls.
- Label library views “My Library” and “Discover loopers” in the left library-pane
  header, rather than reserving a full-width row above the workspace. Keep the
  switcher in the Discover search toolbar when that view is active. Support
  Left/Right, Home/End, roving tab focus, and a labelled tab panel.
- Default new sessions without a saved collection to All tracks. Preserve
  existing collection preferences.
- Distinguish library loading, initial setup, empty collections, and filtered
  searches. Provide contextual setup/import/browse/clear-filter actions.
- Clear filters resets search, source, BPM, and duration together, preserving
  collection, sort, playlists, and track data.
- All tracks, Favorites, and playlists show a Looper column identifying each
  track's owning looper. Single-looper views omit the column because the header
  already names that looper.
- Give the BPM column enough width for its value/status to stay on one line;
  keep track rows at a compact fixed 44 px and render loop titles in compact text.
- Give waveform zoom controls accessible names and disable unavailable zoom
  actions. Respect reduced-motion preferences for CSS transitions.

## Verification

- Run frontend typecheck, tests, and production build.
- In Tauri, check setup and an empty library; import a track and verify playback,
  waveform, filters, favorites, playlists, and the Discover view.
- Check header and transport wrapping in a smaller window, keyboard navigation
  between tabs, focus indicators, and direct access to Audio/MIDI/Shortcuts.
