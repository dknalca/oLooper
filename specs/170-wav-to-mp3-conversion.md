# 170 — On-demand WAV to MP3 320 kbps conversion

## Scope

Let a user convert one library-managed WAV loop to constant-bitrate MP3 at
320 kbps when explicitly requested, replacing only the managed WAV copy after
the output validates.

## User-visible behavior

- Show each loop's current audio format in the library row.
- WAV rows offer **Convert to MP3 (320 kbps)** with a confirmation that the
  managed WAV copy will be removed after a successful conversion.
- Conversion preserves the track ID, owning group, playlist membership,
  favorites, BPM, CUEs, Serato saved loops, and ordinary ID3 metadata where
  supported. Playback/navigation continue to refer to the same loop.
- Only the managed file in the selected library is replaced. Original SWF/EXE
  files and external custom-audio source files are never modified or deleted.
- Conversion failures leave the managed WAV and catalog row intact and remove
  any incomplete MP3 output.

## Supported inputs

- WAV audio with mono or stereo PCM that the existing decoder accepts.

## Persistence behavior

- Update the track's managed path, format, decoded sample properties, duration,
  and frame bounds after MP3 validation. Preserve its stable track ID and source
  identity so playlists and provenance continue to work.
- Move the old managed WAV into the library deletion quarantine before the
  transactional catalog update; purge it only after the update succeeds.

## Acceptance criteria

- [ ] The row displays the format and offers conversion only for WAV loops.
- [ ] Conversion creates a decodable 320 kbps MP3 and replaces the managed WAV
  only after output, metadata, and catalog changes validate.
- [ ] CUEs, saved Serato loops, BPM, group, favorites, playlists, and source
  provenance remain intact across conversion and restart.
- [ ] Conversion failure preserves the WAV and original external/source files.
- [ ] The active track reloads from the MP3 without changing its prior
  play/pause state.

## Non-goals

- Automatic/batch conversion, deleting external originals, format conversion to
  anything except MP3, or exposing a bitrate selector.
