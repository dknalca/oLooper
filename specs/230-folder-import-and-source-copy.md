# 230 — Folder imports and optional looper copies

## Behavior

- One SWF / EXE toolbar action and File menu entry accept mixed selections of
  both formats. A separate Folder action is also available in the File menu.
- Copying SWF/EXE containers defaults to off unless the saved Options preference
  is explicitly enabled. Existing saved true/false preferences remain respected.
- Every local container import confirmation shows the looper count, extraction
  and source-playback choices, and a copy-to-library checkbox initialized from
  Options. This checkbox applies only to that batch and does not alter Options.
- Copying is independent of extraction. Extracted audio always belongs to the
  library; an uncopied SWF/EXE stays external and must never be deleted by the app.
- Source playback without copying requires the original file to remain available.
- The Folder toolbar action selects a directory and recursively discovers SWF
  and EXE files case-insensitively. Other files and symlink entries are skipped.
- Before enqueueing any jobs, show the number of discovered loopers and selected
  folder, then the same mode/copy confirmation as individual imports. Cancel
  performs no import. Empty folders show a no-loopers message.
- Discovery runs off the command thread, sorts paths deterministically, and
  fails explicitly on unreadable entries or limits (100,000 entries / 10,000
  loopers), rather than silently importing a partial scan.
- Folder jobs use the existing sequential queue, progress and cancellation flow.
- Dialog dismissal controls use a visible bordered button with a text label;
  main settings and utility popups show an explicit “× Close” action.

## Verification

- Frontend preference tests cover missing, enabled, disabled and invalid values.
- Rust discovery tests cover nested/mixed-case files, unrelated files, empty
  folders, non-directory inputs, and symlink cycles/aliases on Unix.
- Persistence regression covers extraction without owning the source, playback
  without the original container, and preserving originals on removal.
- Manually verify individual and folder confirmations in both modes with copy
  on/off; cancelling the confirmation must not enqueue any import.
