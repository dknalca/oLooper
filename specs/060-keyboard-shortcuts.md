# 060 — Keyboard Shortcuts

## Scope

Frontend-only keyboard shortcuts for hands-free transport and loop control.
No global shortcuts plugin; listener runs only while the app window is focused.

## User-visible behavior

1. When the app window is focused and no text input is active, keyboard
   shortcuts control playback and loop editing.
2. Shortcuts are disabled when the user is typing in any `<input>` or
   `<textarea>` element (checked via `document.activeElement`).
3. Modifier keys (Cmd/Ctrl/Alt) are ignored to preserve system shortcuts
   (Cmd+C, Cmd+V, etc.).
4. `Cmd+O` is the exception: it opens the native file picker for import.

## Key mappings

| Key | Action | Conditions |
|-----|--------|------------|
| `Space` | Play / Pause toggle | Track loaded |
| `S` | Stop (return to loop start) | Track loaded |
| `←` (Left arrow) | Seek -5 seconds | Track loaded |
| `→` (Right arrow) | Seek +5 seconds | Track loaded |
| `L` | Toggle loop on/off | Track loaded |
| `[` | Set loop start = current position | Track loaded, loop enabled |
| `]` | Set loop end = current position | Track loaded, loop enabled |
| `Cmd+O` / `Ctrl+O` | Open file picker for import | Library initialized |

## Architecture

- `src/hooks/useKeyboardShortcuts.ts` — single `useEffect` with
  `window.addEventListener("keydown", handler)`.
- State bridge: Player component calls `exposePlayerState()` on every
  status update, writing to module-level variables read by the shortcut handler.
- Loop start/end events: `[` and `]` dispatch `CustomEvent`s
  (`olooper:set-loop-start`, `olooper:set-loop-end`) consumed by Player
  to call `player_set_loop`.
- Import event: `Cmd+O` dispatches `olooper:imported` after successful
  import, consumed by App to refresh the sidebar.

## Edge cases

- **Rapid key repeats**: async player calls are chained via a promise
  ref (`pendingRef`) to avoid races.
- **No track loaded**: all transport shortcuts are no-ops.
- **Seek bounds**: clamped to `[0, duration_ms]`.
- **Loop start > end**: allowed (backend clamps); user can adjust after.

## Persistence behavior

- None. Shortcuts are a UI convenience; all state changes go through
  existing player/library commands that handle persistence.

## Acceptance criteria

- [x] Space toggles play/pause when a track is loaded.
- [x] S stops playback and returns to loop start.
- [x] Arrow keys seek ±5s, clamped to track bounds.
- [x] L toggles loop enabled flag.
- [x] `[` and `]` set loop start/end to current position and update the player.
- [x] `Cmd+O` opens native file picker; selected files import automatically.
- [x] No shortcuts fire when typing in an input field.
- [x] No shortcuts conflict with system Cmd+key shortcuts.

## Non-goals

- Global shortcuts (work when app is not focused), custom key remapping,
  macro recording, MIDI controller input.
