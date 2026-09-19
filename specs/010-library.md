# 010 — Library (SQLite + filesystem)

## Scope

Persistent catalog of loopers/tracks. SQLite stores metadata; audio stays as
normal files under a configurable library root. Covers import flows for
`.swf`/`.exe` (parse → atomic copy → rows) and session-persistent cue/loop.

## User-visible behavior

1. User picks a library root (or accepts default) → app creates
   `Loopers/`, `Custom Loops/`, `olooper.db` (migrated) inside it.
2. Import `.swf`/`.exe` → looper folder `Loopers/<name>/` with `NN_<id>.mp3`
   files + one row per sound. Re-import of the same file adds nothing
   (dedup on `(source_hash, source_sound_id)`), reported as "already imported".
3. Track list survives restarts with no re-analysis; missing/moved files are
   flagged per-track (`exists: false`), never silently dropped or duplicated.
4. Cue/loop/BPM edits persist per track and are never overwritten by later
   imports or re-analysis.
5. 4 loop slots (A–D) per track, stored in `loop_slots` table. Slots persist
   across sessions. Deleting a track cascades to delete its slots.
6. The library presents each loop with its source looper, loop name, duration,
   and BPM. Automatically analyzed BPM is normalized by octave into 65–150 BPM;
   user-entered BPM is never changed.

## Supported inputs

- Rows created from `020`/`025` extraction output + custom-audio imports
  (custom-audio copy flow arrives with its own spec; the row shape is shared).

## Outputs

- `ImportReport { looper, added, already_there, sounds }` per import.
- `Track { id, title, file_path, exists, duration_ms, bpm?, cue/loop…,
  provenance… }` for UI and player handoff (`player_load(track.file_path)`).
- `LoopSlot { id, track_id, slot, label, cue_ms, loop_start_ms, loop_end_ms, enabled }`
  for loop slot CRUD.

## Failure behavior

- Unwritable root / path outside root → error, nothing half-written
  (file copies are `tmp → validate → rename`; DB writes are transactional).
- Import of a file with zero extractable sounds → clean error, no looper dir
  left behind (empty dirs removed).
- DB open/migration failure → app starts with library disabled + message,
  never with a half-migrated schema (migrations run in one transaction).

## Persistence behavior

- Schema versioned via `PRAGMA user_version`; migrations 0→1→2 explicit,
  forward-only, tested on a temp DB. Downgrades unsupported (clear error).
- v1→v2 adds `loop_slots` table with `ON DELETE CASCADE`.
- `updated_at` bumps on every user edit; `imported_at` never changes.
- Foreign keys enforced via `PRAGMA foreign_keys = ON`.

## Platform considerations

- rusqlite/bundled: no system SQLite required; identical on all platforms.
- Absolute canonical paths stored; library root relocatable by re-init
  (missing-file flags guide the user, no silent rewrites).

## Security implications

- Looper/file names sanitized (no `..`, no separators, length-capped);
  all writes confined under the library root (prefix check after canonicalize).
- Source content hash (SHA-256) for dedup, not for trust.

## Acceptance criteria

- [x] Import `.swf` real → rows + files; re-import → 0 added, same ids.
- [x] Import `.exe` real → identical sounds via `source_type=exe` + offsets.
- [x] Restart → list intact; rename a file → `exists: false` shown.
- [x] Cue/loop edit → restart → edit preserved.
- [x] Temp-DB tests: migrate, CRUD, dedup conflict, atomicity (no partial rows).
- [x] Loop slots: CRUD works, cascade delete on track removal, schema migration v1→v2.

## Non-goals

- Library relocation wizard, duplicate-audio detection across different
  sources, derenaming, playlists/favorites (future columns already reserved).
