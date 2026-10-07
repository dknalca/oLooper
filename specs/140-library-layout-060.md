# 140 — Library Collections, Playlists, and BPM Review (0.6.0)

## Scope

Reorganize the workspace to give the loop library more vertical room, make the
active looper's artwork prominent, provide one view of every imported or
downloaded track, add non-destructive playlists, and make uncertain BPM estimates
visible and correctable.

## User-visible behavior

- Show the cover for the currently loaded track at a larger size beside the
  waveform. Changing the selected sidebar looper or pausing/stopping playback
  must not change the cover; hide the panel only when no track is loaded.
- Move the SWF, EXE, and audio import actions to the upper toolbar, outside the
  library content pane; the library receives the height recovered from the
  existing import bar.
- Add a virtual **ALL** looper/collection. It lists each track in the library
  once, whether it came from a local SWF/EXE, custom audio, or a Tablist
  download. It does not copy files or change their owning looper/group.
- In ALL, existing search, sorting, source filters, favorites, playback,
  navigation, and export operate on the full set of library tracks.
- Existing per-looper groups and Favorites continue to work as before.
- Source-looper groups can be reordered by dragging them in the sidebar; the
  order persists without changing track ownership or stored audio paths.

## Playlists

- Users can create, rename, and delete playlists; add/remove tracks and reorder
  their entries. Add tracks from a context menu or by dragging a single/multi-
  selected library row onto a playlist. Each track can appear at most once.
- Playlists store ordered references to library track IDs, not copied audio.
  Membership never changes the track's source group or file ownership.
- Playback and previous/next navigation follow the selected playlist's order.
- Deleting a track removes its playlist membership; deleting a playlist never
  deletes tracks or audio files.
- Direct Serato `.crate` export is deferred. Keep playlist entries ordered and
  resolvable to their current managed audio paths for a future exporter.

## BPM review

- Improve tempo estimates and calibrate confidence against accented, unaccented,
  noisy, and half/double-time material.
- Flag analyzed BPM values below the review-confidence threshold in the library.
  Clicking the warning opens the existing manual metadata editor; importing does
  not pause for confirmation.
- Manual BPM corrections remain protected from re-analysis and continue syncing
  through the existing supported Serato audio tags.
- The manual BPM editor includes **Tap tempo**. Four steady quarter-note taps
  produce a tempo estimate that fills the BPM field; saving records it as a
  manual BPM so analysis cannot overwrite it.

## Acceptance criteria

- [ ] The loaded track's cover appears larger beside the waveform regardless of
  sidebar selection or play/pause state; no cover panel appears when no track is
  loaded, and a missing cover uses the placeholder without breaking playback.
- [ ] Import actions are available from the upper toolbar; removing the old
  import bar increases the vertical area available to library rows.
- [ ] ALL includes every library track exactly once across SWF, EXE, custom
  audio, and Tablist imports, including tracks with no group cover.
- [ ] ALL search, filters, sorting, playback, and export work without changing
  the persistent group or file ownership of a track.
- [ ] Existing group navigation, Favorites, and persisted library contents
  remain intact.
- [ ] Dragging a source looper changes its saved sidebar order and leaves its
  group identity and track files unchanged.
- [x] Playlist CRUD and ordered track membership persist across restart; duplicate
  entries are rejected and track/playlist deletion only removes references as
  specified.
- [ ] Playing a playlist and using previous/next follow its saved order.
- [ ] Dragging selected library loops onto a playlist adds them in order without
  moving them out of their groups; dropping a duplicate does not duplicate it.
- [ ] Playlist membership and deletion never copy, move, rename, or delete track
  audio or change its original group.
- [ ] BPM confidence distinguishes accented tempo from unresolved half/double-time
  ambiguity; low-confidence estimates are visibly marked and open manual editing.
- [ ] Manual BPM corrections persist, stay marked manual, and are not overwritten
  by subsequent analysis. Editing only a title or tags preserves BPM provenance;
  explicitly entering or tapping the current numeric value confirms it as manual.

## Non-goals

- Moving, copying, or re-importing tracks to create ALL or playlists; changing
  the existing group model; writing Serato `.crate` files; editing saved Serato
  loop slots.
