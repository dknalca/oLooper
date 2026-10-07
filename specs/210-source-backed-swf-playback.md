# 210 — Source-backed SWF/EXE playback

## Import choice

- The SWF/EXE import controls expose two modes: **Extract audio** (the existing
  behavior) and **Play from source** (the space-saving mode). The selection is
  remembered for later imports; extraction remains the default.
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
- Removing a source-backed track/group removes catalog state and its managed
  cover cache only. The copied SWF/EXE source remains available in the library.

## Acceptance

- Importing the same valid SWF in either mode produces the same playable loop
  list; source-backed mode stores no per-loop audio files.
- Loading an embedded loop decodes the selected sound from the managed source,
  and waveform/seek state is associated with that track rather than the SWF path.
- A missing, modified, malformed, or oversized source fails safely without
  executing it or applying another loop's sound data.
- Source-backed tracks expose only fixed CUE 1, do not read/write Serato tags,
  and removal never deletes the copied SWF/EXE.
