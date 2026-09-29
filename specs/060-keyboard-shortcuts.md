# 060 — Keyboard Shortcuts

## Scope

Frontend keyboard shortcuts for hands-free transport, loop toggle, and cue slots.
No global shortcuts plugin; listener runs only while the app window is focused.

## User-visible behavior

1. When the app window is focused and no text input is active, keyboard
   shortcuts control playback and toggle looping.
2. Shortcuts are disabled when the user is typing in any `<input>` or
   `<textarea>` element (checked via `document.activeElement`).
3. Modifier keys (Cmd/Ctrl/Alt) are ignored to preserve system shortcuts
   (Cmd+C, Cmd+V, etc.).
4. `Cmd+O` opens the native **File → Import Files…** picker.
5. `1`–`4` recall saved cues; pressing an empty cue key saves the current position
   and loop to that slot. `Shift+2`–`Shift+4` clears the corresponding saved cue.
   Cue 1 is fixed at track start; `Shift+1` returns to that start cue.

## Key mappings

| Key | Action | Conditions |
|-----|--------|------------|
| `Space` | Play / Pause toggle | Track loaded |
| `S` | Stop (return to loop start) | Track loaded |
| `←` (Left arrow) | Seek -5 seconds | Track loaded |
| `→` (Right arrow) | Seek +5 seconds | Track loaded |
| `L` | Toggle loop on/off | Track loaded |
| `1`–`4` | Recall cue, or save it if empty | Track loaded |
| `Shift+2`–`Shift+4` | Clear saved cue | Track loaded |
| `Shift+1` | Seek to the fixed start cue | Track loaded |
| `+` | Increase speed by 5% (50–200%) | Track loaded |
| `-` | Decrease speed by 5% (50–200%) | Track loaded |
| `Cmd+O` / `Ctrl+O` | File → Import Files… | Library initialized |

## Architecture

- `src/hooks/useKeyboardShortcuts.ts` — transport shortcuts use a focused-window
  key listener. File-import shortcut is provided by the native application menu.
- Cue shortcuts dispatch `olooper:cue-shortcut`; Player applies them through the
  existing slot load/save/delete commands.
- The native Edit menu exposes platform text-editing actions; File menu actions
  dispatch through `src/tauri.ts` and the app import bridge.
- Help → Keyboard Shortcuts opens the in-app shortcut reference.
- State bridge: Player component calls `exposePlayerState()` on every
  status update, writing to module-level variables read by the shortcut handler.
- Menu import commands are handled by `ImportBar`; completed imports dispatch
  `olooper:imported`, consumed by App to refresh the library.

## Edge cases

- **Rapid key repeats**: async player calls are chained via a promise
  ref (`pendingRef`) to avoid races.
- **No track loaded**: all transport shortcuts are no-ops.
- **Seek bounds**: clamped to `[0, duration_ms]`.

## Persistence behavior

- None. Shortcuts are a UI convenience; all state changes go through
  existing player/library commands that handle persistence.

## Acceptance criteria

- [x] Space toggles play/pause when a track is loaded.
- [x] S stops playback and returns to loop start.
- [x] Arrow keys seek ±5s, clamped to track bounds.
- [x] L toggles loop enabled flag.
- [x] `1`–`4` recall or save cues; Shift+`2`–`4` clear them.
- [x] `+` and `-` change playback speed in 5% steps (50–200%).
- [x] `Cmd+O` opens native file picker; selected files import automatically.
- [x] `1`–`4` load/save cue slots and Shift+`2`–`4` deletes saved cues.
- [x] Help → Keyboard Shortcuts opens a reference dialog.
- [x] No shortcuts fire when typing in an input field.
- [x] No shortcuts conflict with system Cmd+key shortcuts.

## Non-goals

- Global shortcuts (work when app is not focused), custom key remapping,
  macro recording, MIDI controller input.
