# 080 - Portable Drop Import

## Scope

Import a dropped `.swf` or projector `.exe` from anywhere in the window into a portable application library. The source is copied, never moved or executed.

## Storage

- Development builds use the directory containing the executable.
- macOS app bundles use the directory containing `oLooper.app`, never `oLooper.app/Contents`.
- Sources are atomically copied to `loopersFlash/` beside the app bundle/executable.
- The first launch asks the user to confirm a library directory, suggesting `library/` beside the app bundle/executable. The selected path is saved in portable configuration beside the app.
- Extracted files are atomically written to `<selected-library>/<sanitized-looper-name>/NN_<sound-id>.mp3`.
- `<selected-library>/olooper.db` stores catalog data. Existing configurable libraries are not migrated automatically; they remain intact and can be imported again.

## User-visible behavior

1. Dropping SWF/EXE anywhere in the window starts an import job.
2. File → Import Files… (Cmd+O), Open SWF…, Open Projector (EXE)… and Import
   Audio… open native pickers for their supported file types. File → Choose
   Library Folder… opens library setup.
3. Progress reports stages including `copying source`, `analyzing`, `extracting`, `adjusting BPM`, `adjusting loops`, and `inserting in library`, then `complete` or `failed`.
4. Progress includes the current file and sound count when known. Partial failures retain successful tracks and report skipped sounds.
5. The two-pane library refreshes after completion. Its left pane lists looper groups; selecting one shows its tracks on the right. Double-clicking a track loads and plays it.
6. Shared import progress lists each selected file, its current stage, elapsed time, and final added/existing/failed result. The completed result stays visible until dismissed.

## Failure behavior

- Invalid extension, malformed content, inaccessible roots, or failed writes show a clear error and leave the source untouched.
- No partial extracted output is left after a failed individual write. Existing files and catalog rows are never overwritten.
- If the directory beside an installed app is not writable, import fails with a message to move the app to a writable folder.

## Security and non-goals

- SWF/EXE/audio remain untrusted data and are never executed.
- Parsing and decompression stay bounded; writes remain confined to `library/` and `loopersFlash/`.
- Import queue state is not persisted across app restarts; existing library data
  remains on disk when another library is selected.

## Automated verification

- Rust tests cover synthetic FWS/CWS and projector EXE parsing, safe source-copy dedup/collision behavior, and import-stage callbacks.
- Frontend tests cover extension routing and progress-summary state transitions without requiring a Tauri window or real user files.
