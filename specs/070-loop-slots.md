# 070 — Four Serato CUEs

## Scope

oLooper manages four hot cues per track. CUE 1 is always fixed at the beginning
of the audio (`0 ms`). Existing Serato saved-loop metadata is retained but is
not displayed or edited in oLooper.

## User-visible behavior

1. The player shows CUE 1–4 only. CUE 1 always seeks to the start of the track
   and cannot be moved or cleared.
2. Clicking an empty CUE 2–4 saves the current position; clicking a saved CUE
   seeks there. CUEs 2–4 can be changed or cleared.
3. Pressing `1` recalls the track start; `2`–`4` recall or save CUEs. `Shift+2`
   through `Shift+4` clears the corresponding CUE.
4. Manual playback loop controls remain available, but oLooper has no saved-loop
   bank and does not write or delete Serato's saved loops.
5. CUEs loaded from a Serato-tagged file appear when oLooper opens the track.

## Audio metadata

- MP3, WAV and AIFF CUE updates use the legacy ID3 GEOB `Serato Markers_`
  layout that Serato reads for the first four hot cues. CUE 1 is encoded at
  position zero. The fixed fifth cue entry and all nine legacy loop entries are
  preserved from the existing `Markers_` data.
- Existing `Serato Markers2` ID3 frames are left byte-for-byte unchanged on
  MP3/WAV/AIFF updates. This avoids rewriting the newer format while returning
  to the four-CUE `Markers_` behavior that was previously visible in Serato.
- FLAC/Ogg Vorbis and MP4/M4A retain their container-specific marker handling,
  limited to CUEs 1–4. Existing Serato LOOP records are preserved and never
  generated from oLooper state.
- The standard BPM tag remains mirrored. The `loop_slots` SQLite table is read
  only to migrate old cue positions; legacy loop boundaries are ignored and its
  rows are cleared after migration.

## Failure and persistence

- Invalid CUE slots (not 1–4), out-of-track positions, malformed tags, or write
  failures produce an error and leave the managed audio file unchanged.
- CUE 1 is normalized to zero on read/write. Audio tags remain the source of
  truth; the Serato library database/crates are never edited.
- Updates use a verified sibling temporary file and replace only the
  library-managed audio copy.

## Acceptance criteria

- [x] Four CUE positions round-trip through the legacy `Markers_` structure.
- [x] CUE 1 always reads and writes as `0 ms`.
- [x] Updating a CUE preserves existing Serato loop entries and `Markers2` bytes.
- [x] Opening/editing CUEs does not create or clear an oLooper saved-loop bank.
- [ ] Manual: confirm CUEs 1–4 appear in Serato after reload on MP3/WAV/AIFF.
