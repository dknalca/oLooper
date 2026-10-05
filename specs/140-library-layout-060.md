# 140 — Library Layout and All Collection (0.6.0)

## Scope

Reorganize the workspace to give the loop library more vertical room, make the
active looper's artwork prominent, and provide one view of every imported or
downloaded track.

## User-visible behavior

- Show the active looper's cover artwork at a larger size in the waveform area.
- Move the SWF, EXE, and audio import actions to the upper toolbar, outside the
  library content pane; the library receives the height recovered from the
  existing import bar.
- Add a virtual **ALL** looper/collection. It lists each track in the library
  once, whether it came from a local SWF/EXE, custom audio, or a Tablist
  download. It does not copy files or change their owning looper/group.
- In ALL, existing search, sorting, source filters, favorites, playback,
  navigation, and export operate on the full set of library tracks.
- Existing per-looper groups and Favorites continue to work as before.

## Acceptance criteria

- [ ] Selecting a looper shows its cover at the larger size in the waveform
  section; a missing cover uses the existing placeholder without breaking the
  waveform or transport.
- [ ] Import actions are available from the upper toolbar; removing the old
  import bar increases the vertical area available to library rows.
- [ ] ALL includes every library track exactly once across SWF, EXE, custom
  audio, and Tablist imports, including tracks with no group cover.
- [ ] ALL search, filters, sorting, playback, and export work without changing
  the persistent group or file ownership of a track.
- [ ] Existing group navigation, Favorites, and persisted library contents
  remain intact.

## Non-goals

- Moving, copying, or re-importing tracks to create ALL; changing the import
  pipeline or the existing group model; editing saved Serato loop slots.
