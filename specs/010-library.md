# 010 — Library (SQLite + filesystem)

## Scope

Persistent catalog of loopers/tracks. SQLite stores metadata; audio stays as
normal files under a configurable library root. Covers import flows for
`.swf`/`.exe` (parse → atomic copy → rows), custom audio, and per-track cue/loop
slots.

## User-visible behavior

1. User picks a library root (or accepts default) → app creates
   `Custom Loops/` and the migrated `olooper.db` inside it.
2. Import `.swf`/`.exe` → a looper folder `<library>/<name>/` with extracted
   audio files and one row per sound. Re-import of the same file adds nothing
   (dedup on `(source_hash, source_sound_id)`), reported as "already imported".
3. Track list survives restarts with no re-analysis; missing or moved files are
   flagged per-track (`exists: false`), never silently dropped or duplicated.
4. BPM remains catalog metadata and is mirrored to the audio file as ID3 `TBPM`.
   CUEs are persisted in supported audio files and re-read when a track is
   opened, so changes made in Serato are reflected in oLooper.
5. Each track supports four hot cues. CUE 1 is fixed at the start of the track.
   The audio file is their source of truth; legacy schema-v6 cue positions are
   migrated to the file on first read. Existing Serato saved loops are retained
   but are not managed by oLooper.
6. The left pane lists **ALL**, **Favoritos**, playlists, then looper groups.
   ALL contains each catalog track exactly once. Selecting ALL or a group shows
   its matching tracks; search, source/BPM/duration filters, sorting, playback,
   navigation, and export operate on the selected set. Tracks show name,
   duration, BPM, and a review indicator for low-confidence analyzed BPM.
   Automatically analyzed BPM is normalized by octave into 65–150 BPM;
   user-entered BPM is never changed. The active track's group is selected
   automatically only while browsing a source group. The pane divider remains
   resizable and its width is saved between launches.
7. Playlists are ordered sets of unique track references. Users can create,
   rename, delete, add/remove tracks, and change order. Playlist membership does
   not copy audio or change owning groups; playback navigation follows playlist
   order. Removing a track removes its playlist references; deleting a playlist
   leaves all tracks untouched.
8. Users can reorder source-looper groups by dragging them in the left pane. The
   order persists across restarts; newly imported groups are appended.
9. A source-looper group can be renamed, revealed in the file manager, or
   removed. Removing a group removes its catalog rows, loop slots, library audio
   copies and cover. Original SWF/EXE/source files remain on disk.
10. Each loop can be marked as a persistent favorite. The visible per-loop
   trash control removes that loop and its library audio copy after confirmation;
   its original input file is not touched.
11. Each loop has a Play button beside its name; double-clicking a row also starts
   playback.

## Supported inputs

- Rows created from SWF/EXE extraction (`020`/`025`), custom-audio imports
  (`050`), and Tablist catalog imports (`100`).

## Outputs

- `ImportReport { looper, added, already_there, failed, track_ids }` for SWF/EXE
  imports; custom audio returns per-file results.
- `Track { id, title, file_path, exists, duration_ms, bpm?, cue/loop…,
  provenance… }` for UI and player handoff (`player_load(track.file_path)`).
- `SeratoMetadata { cues, loops, bpm }` for audio-file marker data.

## Failure behavior

- Unwritable root / path outside root → error, nothing half-written
  (file copies are `tmp → validate → rename`; DB writes are transactional).
- Import of a file with zero extractable sounds → clean error, no looper dir
  left behind (empty dirs removed).
- DB open/migration failure → app starts with library disabled + message,
  never with a half-migrated schema (migrations run in one transaction).
- Group rename rejects an empty name or a destination folder that already
  exists; the filesystem rename and catalog update are rolled back on failure.

## Persistence behavior

- Schema versioned through v8 via `PRAGMA user_version`; forward migrations are
  transactional and covered by temporary-database tests. Downgrades are unsupported.
- `updated_at` bumps on every user edit; `imported_at` never changes.
- Foreign keys enforced via `PRAGMA foreign_keys = ON`.

## Platform considerations

- rusqlite/bundled: no system SQLite required; identical on all platforms.
- Library paths are stored with track metadata; missing files are flagged rather
  than silently removed. Changing the library root does not migrate its contents.

## Security implications

- Looper/file names sanitized (no `..`, no separators, length-capped);
  all writes confined under the library root (prefix check after canonicalize).
- Source content hash (SHA-256) for dedup, not for trust.
- Deletion only removes recorded `file_path` assets after verifying they are
  inside the library. Original sources referenced by `source_path` are never
  deleted. Audio is moved to a temporary same-library quarantine until the
  SQLite row removal succeeds, then purged.

## Acceptance criteria

- [x] Import `.swf` real → rows + files; re-import → 0 added, same ids.
- [x] Import `.exe` real → identical sounds via `source_type=exe` + offsets.
- [x] Restart → list intact; rename a file → `exists: false` shown.
- [x] Cue/loop edit → restart → edit preserved.
- [x] Temp-DB tests: migrate, CRUD, dedup conflict, atomicity (no partial rows).
- [x] Loop slots: CRUD works, cascade delete on track removal, schema migration v1→v2.
- [ ] Library pane lists ALL, Favoritos, playlists, and source groups while
  preserving existing favorites and group behavior.
- [x] Play button and double-click start the selected track.
- [ ] ALL contains every track once; filters, playback, navigation, and export use
  the full catalog.
- [x] Playlist references, order, migration, and foreign-key cleanup persist
  without copying/deleting audio or changing group ownership.
- [ ] Source-looper order persists through restart; drag-reordering does not
  change group ownership or audio paths.

## Non-goals

- Library relocation wizard, duplicate-audio detection across different
  sources, direct Serato crate export.
