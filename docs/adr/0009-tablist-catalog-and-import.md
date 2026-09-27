# ADR 0009 — Tablist online catalog and looper import

- Status: accepted
- Date: 2026-09-27

## Context

Tablist exposes loopers in a client-side Meilisearch catalog and stores each
looper's complete track metadata in Firestore. Firestore reads require Firebase
App Check from the `tablist.net` origin. Audio and page artwork are hosted as
files on `files.tablist.net`. Its loops are already loop-ready AAC/M4A tracks.

## Decision

- Add a paginated (24 results), date-descending Tablist catalog with text search
  in the library. Query the site's `nodes` Meilisearch index for `type=looper`;
  do not scrape the HTML shell.
- Perform Tablist-origin Meilisearch and App Check/Firestore requests in a
  temporary isolated remote webview. Do not enable Tauri IPC for that page.
- Resolve looper details from published Firestore nodes, and download only
  `loops[].path` and the selected cover image from HTTPS `files.tablist.net`.
  Bound response size, restrict redirects to that host, and validate all audio
  and image bytes before storing them.
- Double-click imports every loop in the existing background worker. Preserve
  each full track as its loop region and retain published BPM when available.
- Keep audio and normalized `cover.jpg` files beside each other under the
  library root. SQLite remains catalog metadata; no schema migration is needed
  for covers.
- Extract the largest complete embedded JPEG from supported SWF image tags and
  use it as the SWF/EXE group's cover when present.

## Consequences

- Tablist catalog search works with its public web-client configuration while
  honoring App Check and the site's browser-origin requirements.
- Meilisearch and the detail-page lookup require network access; local library
  playback remains independent of Tablist after import.
- `src-tauri/examples/tablist_download_test.rs` probes catalog resolution,
  download headers, and audio decoding without bundling the desktop app.
- Cover files are derived local assets and remain on disk when library rows are
  removed, matching the existing audio-retention policy.
