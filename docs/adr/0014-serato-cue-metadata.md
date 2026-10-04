# ADR 0014 — Mirror shared Serato metadata in managed audio copies

- Status: accepted
- Date: 2026-10-02

## Context

oLooper stored CUE slots only in SQLite, while Serato reads its hot cues from
metadata embedded in the audio file. Serato's library database is proprietary
and may contain unrelated user state.

Serato's user documentation states that cue points are saved in the audio file
and recalled when that file is loaded again.

## Decision

- Store four CUEs in Serato marker metadata in the library-managed audio file;
  CUE 1 is always at zero. MP3/WAV/AIFF update only the legacy `Markers_` ID3
  GEOB frame, whose four-cue behavior was previously verified with Serato.
  Existing ID3 `Markers2` frames and all Serato loop entries are preserved.
  FLAC/Ogg use Vorbis comments and MP4/M4A use freeform atoms for four CUEs.
  Mirror known BPM in each container's standard BPM field.
- Read the audio tags whenever oLooper opens the track; edits from either app
  are reflected in the other after reload/open.
- Treat the audio file as the source of truth for CUEs. Migrate old schema-v6
  `loop_slots` cue positions into the file once, ignore saved-loop boundaries,
  then delete those rows.
- Support MP3, WAV, AIFF, FLAC, Ogg Vorbis, and MP4/M4A files; report unsupported
  formats rather than silently changing only SQLite. Raw AAC sidecar metadata
  remains unsupported.
- Never modify external custom-audio sources or original SWF/EXE files, and do
  not read or write Serato's database/crate files.
- Stage a copy in the selected library, validate the tag, then replace the
  managed audio file so a failed tag operation leaves the original bytes intact.

## Consequences

- Serato can discover markers when it loads/reloads the same library-managed
  audio file. Users must reload an already-loaded Serato track or rescan ID3
  tags after oLooper writes markers.
- CUEs are not stored in SQLite. oLooper does not expose or edit saved-loop
  markers. Serato CUEs outside the first four and Serato loops are preserved
  where possible.
- BPM is mirrored as `TBPM`; this does not create or update Serato's proprietary
  beatgrid data.
- Manual playback loops are independent of saved Serato loop markers.
- Audio-file round-trip tests cover MP3, AIFF, FLAC, Ogg Vorbis and M4A.
  FLAC/MP4 require the full Serato `Markers2` payload inside a MIME envelope
  with two null separators after the MIME string; Ogg stores decoded marker
  entries instead. Actual Serato recognition still needs manual verification.
