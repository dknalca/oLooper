# 070 — Loop Slots

## Scope

Multiple named cue/loop points per track, persisted to SQLite.
Four slots (A–D) allow the user to save and recall different loop
regions without overwriting each other.

## User-visible behavior

1. When a track is loaded, the player shows four slot buttons: A B C D.
2. Clicking an empty slot saves the current cue/loop values to that slot.
3. Clicking a filled slot loads its cue/loop values into the player.
4. The active slot is highlighted; slots with saved data show a distinct
   visual style (filled dot / colored background).
5. Loading a track auto-loads slot A if it exists and is enabled.
6. Slot data persists across sessions in the SQLite database.

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
- `src/components/Player.tsx`: slot selector buttons, save/load logic, auto-load slot A on track load.
- Track ID passed via `olooper:track-loaded` custom event from Sidebar.

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

- [x] Four slot buttons (A–D) appear when a track is loaded.
- [x] Clicking empty slot saves current loop values; button style changes.
- [x] Clicking filled slot loads its values into the player.
- [x] Slot A auto-loads on track load if it exists.
- [x] Slots persist across app restarts.
- [x] Deleting a track removes its slots (cascade).
- [x] Schema v1 → v2 migration creates the table without data loss.

## Non-goals

- More than 4 slots, slot naming/reordering, slot copy/paste,
  per-slot color coding, slot export/import.
