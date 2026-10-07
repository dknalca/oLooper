# ADR 0020: Keep SWF/EXE audio source-backed when requested

**Status:** Accepted

## Context

Extracting every embedded loop into a separate WAV/MP3 provides normal audio
files and Serato tags, but duplicates audio already stored in the imported
SWF/EXE. Large loopers can occupy substantially more library disk space.

## Decision

Keep the existing extraction mode and add an opt-in source-backed mode. Both
modes retain a copied SWF/EXE in the selected library. Source-backed catalog
rows identify the source container and embedded sound ID; playback parses that
managed copy and decodes only the selected sound into the audio engine's bounded
memory cache. No temporary or per-loop audio file is written.

Source-backed rows use catalog-only BPM and app loop metadata. They have one
fixed application CUE (slot 1 at time zero), no other Serato cues, and no Serato
tag writes. Explicit user export may materialize a WAV outside the library.
Removing a looper deletes its library-managed SWF/EXE copy once no catalog
tracks reference it, along with extracted audio and covers. External original
inputs are preserved. Files are quarantined before catalog deletion and restored
if the SQLite deletion fails.

## Consequences

- The SQLite schema records whether a row is extracted or embedded.
- The engine accepts a typed decode request with a virtual track key, allowing
  waveform/seek handling to remain track-scoped while reading the container.
- The playback worker verifies source identity and reuses the existing bounded
  SWF/EXE parsers; it never executes projectors.
- Source-backed loops require a valid retained source file at playback time and
  cannot be converted or dragged out as if the container were audio.
