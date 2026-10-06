# ADR 0017 — Use native copy-only file drag-out on macOS

- Status: accepted
- Date: 2026-10-06

## Context

Webview HTML drag data is not a reliable way to hand Finder a native audio
file. oLooper also supports internal track dragging for playlists and playback,
which must not be confused with external file imports.

## Decision

- When a library row drag leaves the oLooper window, start a native macOS
  `NSDraggingSession` with an `NSFilePromiseProvider` for the canonical audio
  file and allow only the copy operation. The row itself is the drag source;
  there is no separate export button.
- Validate the track ID and canonical path under the selected library root
  before creating the file promise. The promise streams a copy to Finder's
  destination when dropped; it never exports a text URL or moves the source.
- Keep internal HTML track drags separate. They may target playlists,
  Favoritos, or the waveform-to-play action and are ignored by the import drop
  handler.
- Keep the native file-drag implementation macOS-gated; other platforms do not
  show the drag-out control until they have an equivalent implementation.

## Consequences

- Finder creates its own copy when the user drops the item; oLooper's managed
  audio and original source remain untouched.
- The drag source uses macOS Objective-C APIs and needs manual verification in
  Finder in addition to path-confinement unit tests.
