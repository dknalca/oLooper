# 160 — Drag library audio out to the desktop

## Scope

Let macOS users drag a library-managed audio copy from its row to Finder or the
Desktop. The receiver gets a copy; oLooper retains and continues using its
managed file.

## User-visible behavior

- Dragging an available loop row outside the oLooper window starts a native
  Finder file-promise drag with copy semantics; there is no separate drag-copy
  button.
- Internal loop drags have only three valid destinations: a created playlist,
  Favoritos, or the waveform area to play the loop. They never enter the file
  importer.
- Playlist drop adds an ordered reference; Favorites drop marks the loops as
  favorites; waveform drop loads and plays the first dragged loop.
- The currently loaded loop cover is also a drag source for adding that loop to
  a created playlist.
- Dragging audio out uses only a canonical file path verified inside the
  selected library root. It does not move, modify, or re-export the original
  source.

## Acceptance criteria

- [ ] Dropping a dragged audio file on the macOS Desktop creates a playable copy
  and leaves the library audio and original sources intact.
- [ ] Dragging a track inside oLooper only accepts playlists, Favoritos, and
  waveform playback; it does not show import progress or start an import.
- [ ] Dragging the visible current-loop cover onto a playlist adds that loop
  there.
- [ ] Drag-out rejects missing tracks and paths outside the selected library.

## Platform considerations

- Native file drag-out is macOS-only. Other platforms do not show the drag-out
  handle until they have an equivalent native file-drag implementation.
