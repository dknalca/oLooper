# 070 — Cue Slots

## Scope

Four numbered cue slots per track, persisted to SQLite. Cue 1 is fixed at the
track start; cues 2–4 save and recall positions without replacing one another.

## User-visible behavior

1. The player shows buttons CUE 1–4. Cue 1 always seeks to the track start.
2. Clicking an empty cue 2–4 saves the current playback position and loop data.
3. Clicking a saved cue seeks to its saved playback position.
4. The active cue is highlighted; saved cues have a distinct visual style.
5. Cues 2–4 persist across sessions in SQLite; loading a track does not
   automatically seek to a saved cue.
6. Pressing `1`–`4` recalls a cue or saves it if empty. `Shift+2`–`Shift+4`
   deletes a saved cue. `Shift+1` seeks to cue 1; cue 1 cannot be deleted.

## Architecture

### Database

New table `loop_slots` added in schema migration v1→v2:

```sql
CREATE TABLE loop_slots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),
  label TEXT NOT NULL DEFAULT 'A',
  cue_ms INTEGER NOT NULL DEFAULT 0,
  loop_start_ms INTEGER NOT NULL DEFAULT 0,
  loop_end_ms INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(track_id, slot)
);
```

- `ON DELETE CASCADE`: removing a track auto-deletes its slots.
- `UNIQUE(track_id, slot)`: one row per slot per track.
- `enabled` flag: slot has been explicitly saved (vs. default empty).

### Backend (Rust)

Methods on `Library`:
- `get_slots(track_id) → Vec<LoopSlot>` — all slots for a track, ordered by slot number.
- `set_slot(track_id, slot, label, cue_ms, loop_start_ms, loop_end_ms, enabled) → LoopSlot` — upsert (INSERT ON CONFLICT UPDATE).
- `delete_slot(track_id, slot) → bool` — remove a slot.

Tauri commands: `library_get_slots`, `library_set_slot`, `library_delete_slot`.

### Frontend

- `src/tauri.ts`: `LoopSlot` interface, `libraryGetSlots`, `librarySetSlot`, `libraryDeleteSlot` wrappers.
- `src/components/Player.tsx`: CUE 1–4 controls and keyboard save/load/delete actions.
- App passes the active library track ID to Player.

## Failure behavior

- Invalid slot number (not 1–4) → backend error.
- Track not found → backend error.
- DB error → error propagated to UI, slot state unchanged.

## Persistence behavior

- Slots are stored in `loop_slots` table, survives restarts.
- Cascade delete: removing a track removes all its slots.
- Schema migration: v1 databases get the table created on next open.

## Security implications

- Same constraints as `010`: all writes confined under library root.
- Slot values are user-controlled ms values; backend validates bounds
  against track duration.

## Acceptance criteria

- [x] Four CUE 1–4 buttons appear when a track is loaded.
- [x] CUE 1 seeks to the start; empty cues 2–4 save the current position.
- [x] Clicking or pressing a saved cue seeks to its saved position.
- [x] Shift+2–4 deletes the saved cue; cues persist across restarts.
- [x] Deleting a track removes its cues (cascade).
- [x] Schema v1 → v2 migration creates the table without data loss.

## Non-goals

- More than 4 slots, slot naming/reordering, slot copy/paste,
  per-slot color coding, slot export/import.
