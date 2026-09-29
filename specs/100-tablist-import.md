# 100 — Tablist.net online catalog, import, and cover art

## Goal

Browse the public Tablist looper catalog from the library, then import every
audio entry from a looper. Tablist loops are already prepared for repetition:
preserve their program and published BPM, trim only short near-silent AAC
encoder padding at the file edges during decoding, and do not run oLooper's
loop-boundary suggestion.

## Verified Tablist behavior

- The SPA resolves a published `nodes` Firestore document by matching the URL
  path against its `paths` array.
- Each page's `loops` array is played by requesting
  `https://files.tablist.net/{loop.path}` as audio bytes. The loop objects also
  expose an id and BPM. `files` and `mediaFiles` are separate page content.
- Tablist initializes Firebase App Check with its reCAPTCHA v3 site key before
  querying Firestore. Direct Firestore REST access without an App Check token
  returns 403 `PERMISSION_DENIED`.
- The site's Meilisearch `nodes` index contains `looper` entries with `nid`,
  `title`, `tags`, loop names, cover thumbnail path, page `path`, and `date`.
  The site's catalog filters `type = "looper"`, sorts by `date:desc`, and
  requests 24 results at a time.

## Import behavior and constraints

- The library offers local and Tablist catalog views. The catalog searches and
  pages through Meilisearch results in 24-item pages, newest first. Ignore hits
  whose route cannot be safely normalized to `looper/<slug>`.
- The Tablist catalog is the **Download new Loopers** view. Direct URL entry is
  not exposed in the shared import bar; users browse/search and import from the
  catalog.
- **Descargar Random Looper** chooses a random valid entry across the complete
  unfiltered catalog, regardless of the current search or page, skipping routes
  that are invalid or already fully downloaded. It imports the selected looper's
  tracks using the same background job.
- Double-clicking a catalog entry imports all its `loops[]` tracks using the
  existing background import job and progress events.
- Accept only HTTPS `tablist.net/looper/<slug>` URLs (optional `www` and trailing
  slash). Resolve only published looper documents, then download only paths from
  `loops[]` on `files.tablist.net`.
- Run resolution, sequential downloads, audio validation, and library writes on
  the existing background import worker. Enforce response size/count limits,
  timeouts, safe redirects, supported audio decoding, cancellation, and per-loop
  progress/errors. Never fetch arbitrary hosts from untrusted page data.
- Tablist stores tracks as AAC in M4A containers. Include Symphonia AAC/ISO-MP4
  decoding; rodio's built-in MP4 adapter panics during initialization on these
  files, so `player::decode_bytes` handles ISO-BMFF directly. M4A decoding trims
  up to 150 ms of near-zero AAC padding from either edge; the downloaded source
  stays unchanged and a long or entirely silent intro is not trimmed.
- Use the first page image's largest available path (`path800`, then smaller
  variants) as the group's local `cover.jpg`; fall back to the Meilisearch
  `image` thumbnail when Firestore omits its `images` field. Normalize covers
  to a bounded 512-pixel JPEG thumbnail.
- Resolve the node in a temporary, isolated `tablist.net` webview so reCAPTCHA
  and App Check execute on Tablist's origin; pass only the returned public
  looper data back to the importer. Do not grant the remote page Tauri IPC access.
- Group imported tracks under the Tablist looper title, keep the source page URL
  as metadata, deduplicate stable loop identities, and retain the original
  audio files under the library root. Covers live beside the group audio. The
  track/group removal deletes the imported audio and cover copies while keeping
  source inputs unchanged.

## Verification

- Unit-test URL/path validation, catalog response decoding, search request
  serialization, and Firestore document decoding with JSON fixtures.
- Unit-test track persistence, full-file loop bounds, BPM preservation, and
  stable deduplication without external network access.
- Manual/live test the example URLs: expected catalog results are paged, the
  expected loop list is non-empty, each
  download is HTTPS from `files.tablist.net`, bytes decode, and imported tracks
  play and loop across the full file. The direct-Rust Firestore endpoint itself
  is expected to reject requests without the webview-issued App Check token.
- Fast network/decoder probe without building the app: from `src-tauri/`, run
  `cargo run --example tablist_download_test -- <Tablist URL...>`; downloads
  appear under `../.dev/tablist-downloads/`.
