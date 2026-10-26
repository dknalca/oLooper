# 130 — Serato CUE metadata sync

> v0.8.0 resolves DOC-A01/DOC-A02: a durable pending-sync marker protects manual
> BPM between confirmation and tag sync; CUE writes never create automatic BPM
> tags. Historical follow-up descriptions below are superseded by
> [the release record](../docs/release-0.8.0.md).

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
3. An explicitly confirmed manual BPM is stored in the catalog and synchronized
   to the supported managed-audio file. Automatic BPM estimates remain catalog
   metadata until the user confirms one. The reanalysis/half-double workflows are
   described in specs 260/270.
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
- Only an explicitly confirmed manual BPM is synchronized using `TBPM` for ID3,
  `BPM` for Vorbis comments, and `tmpo` for MP4. Automatic analysis remains in
  the catalog; this does not update Serato's proprietary beatgrid.
- CUEs are not written to SQLite. Existing schema-v6 `loop_slots` rows migrate
  only their cue positions before WAV normalization; old saved-loop boundaries
  are ignored and those rows are then deleted. Serato databases/crates are never
  read or modified.
- Writes use a verified exclusive sibling temporary file and replace only the
  library-managed audio copy. All metadata/removal operations on a library are
  serialized by an exclusive library lease plus an in-process mutex, so
  concurrent CUE edits cannot overwrite each other.
- If a Windows replacement is interrupted, the backup name includes the full
  audio filename (`<file>.serato-backup-*`). Recovery on the next metadata read
  or library open restores only backups whose header matches the missing audio
  format; legacy backups without the extension are validated the same way.

### Follow-up audit issue (2026-10-26)

The intended precedence above is not fully enforced yet. A possible ordering
race between saving a manual BPM and a CUE/tag read can let a stale file `TBPM`
replace the just-confirmed catalog BPM before tag synchronization. Also, writing
a CUE may copy an automatic catalog BPM into file tags, after which batch
reanalyze treats that tag as externally authoritative. Both cases were reproduced
and are open findings in `docs/documentation-review-2026-10-26.md`; do not treat
the intended provenance guarantees as fully verified until fixed and retested.

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
