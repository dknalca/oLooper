# ADR 0015 — Playlists reference library tracks

- Status: accepted
- Date: 2026-10-06

## Context

Users need to curate loops across imported groups without copying audio or
changing the track's original group. Playlists may later be exported for use as
Serato crates, but crate-file compatibility is not part of the initial feature.

## Decision

- Persist playlist names and ordered track membership in SQLite. A playlist may
  contain a given library track once; membership references the track row ID.
- Track ownership, managed audio files, and source files remain independent of
  playlist membership. Deleting a track cascades only its playlist references;
  deleting a playlist never deletes tracks or audio.
- Playback navigation follows the selected playlist's saved order.
- Defer Serato `.crate` generation to a separate feature. Do not read or modify
  Serato databases/crates as part of playlist persistence.

## Consequences

- Playlist persistence uses a transactional schema migration and foreign-key
  cleanup; no audio-copy or import pipeline changes are required.
- A future crate exporter can resolve ordered track IDs to current managed audio
  paths without making the Serato file format the canonical playlist store.
