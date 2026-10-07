# 210 — Source-backed SWF/EXE playback

## Import choice

- When SWF/EXE files are selected or dropped for import, ask whether to **Extract
  audio** (the existing behavior) or **Play from source** (the space-saving mode).
  Ask for each import batch; do not keep a persistent mode selector or preference.
- Both modes copy the original SWF/EXE into the selected library's
  `loopersFlash/` directory and create one catalog row per supported sound.
- Source-backed rows reference the managed container and sound ID. They do not
  create managed WAV/MP3 files. BPM analysis happens during import and remains
  catalog metadata.

## Playback and metadata

- On selection, the audio worker revalidates the copied source hash, parses the
  SWF (or locates/parses the embedded SWF in an EXE), decodes only the requested
  sound, and keeps PCM in bounded memory/cache. It creates no temporary audio
  file. Existing parser and input-size limits remain in force.
- The audio engine uses a stable per-track playback key so seeking and waveform
  generation work without exposing the source container as an audio file.
- Source-backed tracks always have application CUE 1 at time zero. CUEs 2–4 and
  Serato tag writing are unavailable; the SWF/EXE is never modified. Catalog
  BPM, favorites, playlists, app loop bounds, and manual playback controls remain
  track-local. Explicit export may produce a WAV in the user's chosen folder.
- Removing a track/group removes its catalog state, extracted audio files (when
  present), and managed cover cache. When no remaining catalog track references
  the imported container, its library-owned copy in `loopersFlash/` is removed.
  The original SWF/EXE outside the library is never deleted.
- Before deleting a looper, show a confirmation popup explaining that its
  imported SWF/EXE library copy (when applicable), extracted/downloaded audio
  files (if present), and cover will be deleted. Cancellation must not start
  deletion; explicit acceptance is required. External originals remain intact.

## Acceptance

- Importing the same valid SWF in either mode produces the same playable loop
  list; source-backed mode stores no per-loop audio files.
- Loading an embedded loop decodes the selected sound from the managed source,
  and waveform/seek state is associated with that track rather than the SWF path.
- A missing, modified, malformed, or oversized source fails safely without
  executing it or applying another loop's sound data.
- Source-backed tracks expose only fixed CUE 1, do not read/write Serato tags,
  and deletion removes the last unreferenced library copy while preserving the
  user's original SWF/EXE input.
