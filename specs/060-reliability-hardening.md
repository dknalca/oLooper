# 060 - Reliability and Safety Hardening

## Scope

Make existing playback, import, library selection, and CWS extraction reliable without changing the audio-library ownership model.

## Acceptance criteria

- Selecting a track updates transport controls, waveform, and keyboard shortcuts from one native player status stream.
- `Cmd+O`/`Ctrl+O` imports audio, SWF, and projector files through their matching backend command.
- Toggling looping while playing changes the active audio source immediately.
- Valid CWS files whose compressed bytes are smaller than their declared uncompressed length import successfully; decompression cannot exceed the declared safety bound.
- First launch asks the user to confirm a library root, defaulting to `library/` beside the executable/app bundle; that portable selection persists beside the app.
- Revealing a track uses a typed backend command; the webview has no general shell-execute permission.
- Automated tests cover CWS size handling, migrations to schema v2, player loop toggling, and the repaired frontend command routing where practical.

## Failure and persistence behavior

- CWS length or decompression failures return a normal import error and never write output files.
- The selected library contains the portable catalog and audio together; its selection file remains beside the executable/app bundle.
- Reveal failures are returned to the UI without executing a shell command string.

## Security and non-goals

- SWF, EXE, and audio remain untrusted data; decompression and file reads stay bounded.
- Do not execute imported files or Flash content.
- This does not add background imports, a waveform disk cache, or a pro-audio engine.
