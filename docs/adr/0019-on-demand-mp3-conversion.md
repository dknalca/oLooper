# ADR 0019 — Convert WAV copies to MP3 only on user request

- Status: accepted
- Date: 2026-10-06

## Context

WAV loops can consume substantially more library storage than their compressed
MP3 equivalents. The original WAV may be an external custom-audio source or
audio extracted from an SWF/EXE and must remain protected.

## Decision

- Use the pure-Rust `rusty_mp3` encoder to produce CBR 320 kbps MP3 without an
  external FFmpeg/LAME executable.
- Convert only the library-managed WAV copy, and only after an explicit user
  action and confirmation. Keep the track ID, source identity, group, playlists,
  and user metadata stable.
- Copy the WAV's ID3 metadata to the MP3, update supported Serato CUE/BPM tags,
  decode-validate the MP3, then transactionally switch the catalog path and
  quarantine/purge the WAV copy.
- Never change or delete `source_path` assets. A failed conversion leaves the
  WAV and catalog row untouched.

## Consequences

- The catalog's format/path fields become MP3 after successful conversion while
  references from playlists continue to resolve through the stable track ID.
- The encoder is permissively licensed (Apache-2.0), pure Rust, and included in
  the existing bundled app; no user-installed conversion tool is required.
