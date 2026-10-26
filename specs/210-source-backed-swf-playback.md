# 210 — Source-backed SWF/EXE playback

## Import choice

- When SWF/EXE files are selected or dropped for import, ask whether to **Extract
  audio** (the existing behavior) or **Play from source** (the space-saving mode).
  Ask for each import batch; do not keep a persistent mode selector or preference.
- Both modes create one catalog row per supported sound. Copying the SWF/EXE is
  opt-in independently of extraction; the per-import checkbox defaults to the
  saved Options preference (off when unset). See spec 230 for folder imports.
- Source-backed rows reference the selected managed copy or external original
  path and sound ID. They do not
  create managed WAV/MP3 files. BPM analysis happens during import and remains
  catalog metadata.

## Playback and metadata

- On a container-cache miss, the audio worker revalidates the source hash, parses
  the SWF (or locates/parses the embedded SWF in an EXE), decodes only the
  requested sound, and keeps PCM in bounded memory/cache. It creates no temporary audio
  file. Existing parser and input-size limits remain in force.
- Keep up to two verified, decompressed containers in a shared in-memory LRU
  cache, with a dynamic budget of one eighth of available system RAM and a hard
  cap of 256 MiB total. Reuse them across sounds and analysis requests
  without rereading, hashing, or decompressing unchanged files. Cache identity
  includes path, source type, expected hash, size, and modification time (plus
  filesystem identity/change time on Unix). Missing metadata disables reuse;
  changed files require fresh hash verification. Never hold the cache lock during
  I/O or decoding. Oversized containers remain playable without being retained.
  Even an oversized insertion trims older entries to the current budget.
- Retain up to 32 decoded loops under a dynamic budget of one eighth of available
  system RAM, capped at 512 MiB, so short loops remain available across more
  selections. Both caches are memory-only; source-backed playback still creates
  no audio files.
- Source-backed import prepares PCM and BPM only; it must not serialize unused
  WAV output or copy compressed file payloads for extracted-audio storage.
- Random playback inside a selected looper is limited to that looper's tracks;
  **All** scope selects across the complete library.
- Playback skips unrelated sounds and all cover decoding. EXE candidate
  validation checks container/tag bounds without decoding every sound. It must
  not repeat BPM analysis or serialize a WAV just to obtain a PCM buffer.
- Flash ADPCM emits the initial predictor and then up to 4095 delta frames
  per block (4096 output frames per full block). Mono,
  stereo, and 2–5-bit codes preserve sample alignment across block boundaries.
  Check the minimum encoded bit count before allocating/decoding PCM; truncated
  payloads fail without fabricating samples. Read packed codes in byte groups.
- The audio engine uses a stable per-track playback key so seeking and waveform
  generation work without exposing the source container as an audio file.
- Source-backed tracks always have application CUE 1 at time zero. CUEs 2–4 and
  Serato tag writing are unavailable; the SWF/EXE is never modified. Catalog
  BPM, favorites, playlists, app loop bounds, and manual playback controls remain
  track-local. Explicit export may produce a WAV in the user's chosen folder.
- Removing a track/group removes its catalog state, extracted audio files (when
  present), and managed cover cache. When no remaining catalog track references
  the imported container, its library-owned copy in `loopersFlash/` is removed.
  The original SWF/EXE outside the library is never deleted, including when an
  import directly references that original.
- Attempting to play a source-backed track whose file is missing shows its path
  and asks whether to remove the entire looper group from the catalog. Only an
  explicit confirmation removes the rows; it never deletes the external source.
- Before deleting a looper, show a confirmation popup explaining that its
  imported SWF/EXE library copy (when applicable), extracted/downloaded audio
  files (if present), and cover will be deleted. Cancellation must not start
  deletion; explicit acceptance is required. External originals remain intact.

## Acceptance

- Importing the same valid SWF in either mode produces the same playable loop
  list; source-backed mode stores no per-loop audio files.
- Loading an embedded loop decodes the selected sound from the managed or
  external source,
  and waveform/seek state is associated with that track rather than the SWF path.
- A missing, modified, malformed, or oversized source fails safely without
  executing it or applying another loop's sound data.
- Selective FWS/CWS parsing matches full parsing for the chosen sound, including
  stream IDs; invalid tag/container bounds still fail after a matching sound.
- MP3 playback from a compressed SWF or EXE matches imported PCM sample-for-sample
  including seek/count trimming, and never modifies the external source.
- The optional `OLOOPER_TURNTABLE_FIXTURE` regression detects and decodes all 70
  training-looper DefineSound tracks; library regression imports all 70 without
  a source copy, checks source-backed playback, and checks real audio extraction
  with copying disabled. Original SWF bytes remain unchanged on removal.
- Source-backed imports with source copying disabled create no container copy;
  deleting their catalog group preserves the original file.
- Source-backed tracks expose only fixed CUE 1, do not read/write Serato tags,
  and deletion removes the last unreferenced library copy while preserving the
  user's original SWF/EXE input.
