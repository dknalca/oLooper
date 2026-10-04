# 130 — Serato CUE metadata sync

## Scope

Share four CUE positions and BPM through tags embedded in oLooper-managed audio
files. CUE 1 is always at the beginning of the track. Serato saved loops are
preserved in tags but are not managed or displayed by oLooper.

Serato documents that hot cues are saved to the audio file and recalled when
the file is loaded again: [Cue Points](https://support.serato.com/hc/en-us/articles/226518228-Cue-Points).

## User-visible behavior

1. Saving or clearing CUE 2–4 writes marker data directly into the
   library-managed audio file. CUE 1 is fixed at `0 ms` and cannot be moved or
   cleared.
2. Opening a track in oLooper reads the first four CUEs and BPM from that file.
   Serato changes to these CUEs appear when the track is reopened in oLooper.
3. BPM edits use the container's BPM tag. The **Audio tags** action can rewrite
   the current CUEs and BPM at any time.
4. After oLooper writes tags, reload the track in Serato or use **Rescan ID3
   Tags** so Serato rereads the file metadata.
5. MP3, WAV, AIFF, FLAC, Ogg Vorbis, and M4A/MP4 library files have marker
   writers. Raw AAC and other unsupported extensions report an error; CUEs are
   not saved to an oLooper-only database.
6. Only the copy inside the selected oLooper library is modified. The original
   SWF/EXE or external custom-audio file is never changed.

## Metadata behavior

- MP3/WAV/AIFF writes use the legacy `Markers_` GEOB tag. It has five cue records
  and nine legacy loop records. oLooper writes CUEs 1–4, fixes CUE 1 at zero,
  preserves cue 5 and all loop records byte-for-byte, and leaves any existing
  `Markers2` frame unchanged.
- FLAC, Ogg Vorbis, and MP4/M4A use their container-specific Serato marker
  storage, limited to CUEs 1–4. Existing Serato LOOP entries are retained. For
  MP4/M4A, update the legacy `markers` atom while leaving any existing
  `markersv2` atom intact. Serato's trailing legacy marker byte need not be
  zero and must be preserved when editing its file.
- WAV uses one lowercase RIFF `id3 ` chunk with ID3v2.3. If old versions left
  both `ID3 ` and `id3 ` chunks, merge ordinary frames and prefer lowercase
  markers when present, even when cleared; fall back to uppercase markers only
  if lowercase has none.
- BPM is mirrored using `TBPM` for ID3, `BPM` for Vorbis comments, and `tmpo` for
  MP4. This does not update Serato's proprietary beatgrid.
- CUEs are not written to SQLite. Existing schema-v6 `loop_slots` rows migrate
  only their cue positions before WAV normalization; old saved-loop boundaries
  are ignored and those rows are then deleted. Serato databases/crates are never
  read or modified.
- Writes use a verified exclusive sibling temporary file and replace only the
  library-managed audio copy.

## Failure behavior

- Missing files, unsupported audio extensions, malformed marker tags, or tag
  write failures are shown to the user. Failed writes leave the managed audio
  copy unchanged.

## Acceptance criteria

- [x] Legacy marker serialization round-trips four CUEs with CUE 1 fixed at zero.
- [x] A Serato-authored M4A with a nonzero legacy footer is readable and a CUE
  can be changed on a copy without modifying its existing `markersv2` atom.
- [x] Updating CUEs preserves existing Marker_ loops and existing ID3 Markers2.
- [x] WAV round-trip preserves unrelated GEOB metadata and decoded PCM.
- [x] Cleared lowercase WAV markers are not restored from a stale uppercase chunk.
- [ ] Manual: verify CUEs 1–4 appear in Serato after reload/rescan on MP3/WAV/AIFF
  and confirm existing Serato saved loops remain intact.
