# 090 - Library Workflow Completion

## Scope

Complete the remaining library and delivery workflows: cooperative import
cancellation, persistent library presentation, metadata edits, recents, safe
loop export, and a reproducible macOS release workflow.

## Import cancellation

- Cancelling a job stops before the next sound/file unit. The currently
  writing unit finishes atomically or is discarded; completed tracks remain.
- Pending queue entries are marked cancelled. Cancellation is never persisted
  across app restarts.

## Library workflow

- Filter/sort preferences, playback speed, and pitch-lock setting persist in
  local application settings.
- Track title, manual BPM, and tags are editable. Manual BPM remains protected
  from later analysis. Recent playback is recorded locally.

## Export

- Users choose an export folder. Selected loops are copied, never moved, with
  collision-safe names. Sources and library audio remain unchanged.

## macOS release

- The release script produces an unsigned DMG. Signing/notarization is an
  explicit optional CI/manual step driven by credentials outside the repo.

## Non-goals

- Cancelling an individual atomic write mid-copy, cloud sync, DRM, and storing
  Apple credentials in the repository.
