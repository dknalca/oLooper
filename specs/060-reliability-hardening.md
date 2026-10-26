# 060 - Reliability and Safety Hardening

> Historical hardening snapshot. The library root is now persisted in app
> preferences; the beside-the-app `olooper-library.json` is read only as a
> one-time migration from older builds. Current details: ADR 0006 and spec 010.

## Scope

Make existing playback, import, library selection, and CWS extraction reliable without changing the audio-library ownership model.

## Acceptance criteria

- Selecting a track updates transport controls, waveform, and keyboard shortcuts from one native player status stream.
- `Cmd+O`/`Ctrl+O` imports audio, SWF, and projector files through their matching backend command.
- Toggling looping while playing changes the active audio source immediately.
- Valid CWS files whose compressed bytes are smaller than their declared uncompressed length import successfully; decompression cannot exceed the declared safety bound.
- First launch asks the user to confirm a library root, defaulting to
  `oLooper_data` inside the OS-resolved Documents folder; the selected path is
  remembered in application preferences, never in a file beside the app.
- Revealing a track uses a typed backend command; the webview has no general shell-execute permission.
- Automated tests cover CWS size handling, migrations to schema v2, player loop toggling, and the repaired frontend command routing where practical.

## Failure and persistence behavior

- CWS length or decompression failures return a normal import error and never write output files.
- The selected library contains the portable catalog and audio together. Its
  path is remembered in application preferences, not beside the executable.
- Reveal failures are returned to the UI without executing a shell command string.

## Security and non-goals

- SWF, EXE, and audio remain untrusted data; decompression and file reads stay bounded.
- Do not execute imported files or Flash content.
