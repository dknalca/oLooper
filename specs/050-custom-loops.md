# 050 — Custom Loops

## Scope

First-class import of user-produced audio (drag&drop or path): validate,
copy into `Custom Loops/`, analyze BPM, create editable default cue + loop,
ready to practice immediately with the same player/waveform as extractions.

## User-visible behavior

1. User drops WAV/MP3 (one or many) onto the Library section → each file
   validates; valid ones copy in, appear in the list, playable at once.
2. User can also click Browse buttons (SWF/EXE/Audio) which open native
   OS file pickers via `tauri-plugin-dialog`. Selected files auto-import.
3. Each import gets: duration, waveform (on demand), BPM estimate + confidence,
   default cue = 0, default loop = full track, loop enabled.
3. Re-dropping the same file reports "already in library" (hash dedup), no copy.
4. Name collisions (different audio, same filename) resolve as
   `name (2).ext`, never overwrite.
5. Unsupported/corrupt files fail per-file with reason; the rest import.

## Supported inputs

- Whatever rodio/Symphonia decodes (WAV, MP3; AIFF if the bundled codecs
  handle it). Max 512 MiB per file, 15 min duration (player limits).

## Outputs

- Rows with `source_type=custom`, `source_hash` = file SHA-256,
  `source_sound_id` = 0, `bpm_source='analyzed'` (or NULL when no estimate).

## Failure behavior

- Uninitialized library → "init the library first".
- All-files-failed → single clear error; partial success reports per file.

## Persistence behavior

- Same guarantees as `010`: transactional rows, atomic copies, edits win over
  analysis. Manual BPM corrections set `bpm_source='manual'` and are never
  overwritten (no background re-analysis exists).

## Platform considerations

- Drag&drop paths come from the webview event (no extra FS capabilities).
  Backend re-validates every path (confinement not needed: reads only).

## Security implications

- Dropped files are untrusted: decode in the same hardened path as playback,
  filename sanitized, writes confined to `Custom Loops/`.

## Acceptance criteria

- [x] Drop a WAV + an MP3 → both listed, playable, looped full-track.
- [x] Click-track fixture estimates BPM within ±1 (test, synthetic).
- [x] Silence/ambient yields no estimate (NULL), import still succeeds.
- [x] Same file twice → second is a no-op; same name different bytes → `(2)`.
- [x] Unit tests: estimator on synthetic clicks, collision naming, dedup.
- [x] Native file picker: Browse buttons open OS dialog, selected files import.

## Non-goals

- Half/double-time disambiguation UI, beatgrid, key detection, batch progress
  UI (sequential with a busy flag is enough), moving/copying policy choice
  (MVP always copies; originals untouched).
