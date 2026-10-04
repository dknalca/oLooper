# 020 — SWF Extraction

## Scope

Parse `.swf` as data and extract embedded audio for the library.
Never executes ActionScript; never requires Flash.

## User-visible behavior

1. User drops/opens a `.swf` → app reports sounds found / extracted / unsupported.
2. Each extracted sound becomes a library track with `source_type=swf`,
   `source_sound_id`, ordering preserved when the SWF gives reliable order.
3. Unsupported sound codecs fail per-sound with a clear message; the file as
   a whole still imports whatever is supported. Source file never modified.

## Supported inputs

- `FWS` (uncompressed) and `CWS` (zlib-compressed) containers, versions ≤ 40.
- `DefineSound` (tag 14) with format MP3 (format id 2): frames preserved
  byte-identical, no transcoding. The 2-byte `SeekSamples` prefix and any
  leading non-frame padding (observed: 417 zero bytes prepended by authoring
  tools) are stripped — verified: payload must start at a valid frame sync,
  else the sound is reported skipped. Stripping is de-containering, and the
  trimmed count is kept in provenance.
- `DefineSound` Flash ADPCM (format id 1) is decoded to a derived PCM WAV.
  The source SWF remains untouched; malformed bitstreams and unreasonable
  declared sample counts are skipped per sound.
- `ZWS` (LZMA) and remaining non-MP3/non-ADPCM sound formats are explicitly
  unsupported, reported as `unsupported`, never guessed.
- MP3 streaming audio declared by `SoundStreamHead`/`SoundStreamHead2` and
  carried by `SoundStreamBlock` is assembled in frame order into a derived
  track. Blocks have bounded aggregate size and malformed stream headers or
  blocks are skipped without affecting independent `DefineSound` extraction.
- Sound decoding and BPM analysis use bounded batches of up to four threads;
  derived-file writes and SQLite rows commit serially in source order.
- The largest complete embedded JPEG from `DefineBits`, `DefineBitsJPEG2`,
  `DefineBitsJPEG3`, or `DefineBitsJPEG4` is offered as the looper cover. EXE
  projectors use the cover from their validated embedded SWF. Some JPEG2 tags
  contain a JPEG table stream followed by the image stream; merge the table and
  image markers before normalizing the thumbnail.

## Outputs

- MP3 frames are preserved; Flash ADPCM is written as derived PCM WAV. Validated
  audio files are atomically written as `<library>/<looper-name>/NN_<id>.<codec>`.
- Extracted MP3/WAV files get ID3 `TPE1` from a source filename prefix of
  `Artist - Looper Name` and `TALB` from `Looper Name`; without that separator,
  artist is left unset and album uses the full looper name.
- A valid cover is normalized to a bounded JPEG thumbnail stored beside audio
  as `cover.jpg`; it is also embedded in every extracted track as an ID3
  `APIC` front-cover frame and is removed with the final track or its group.
- Provenance per track: `source_type=swf`, `source_path`, `source_hash` (of the
  `.swf`), `source_sound_id`, `imported_at`.

## Failure behavior

- Truncated header / bad magic / declared length mismatch → `InvalidSwf`
  (what failed, source intact, try another file).
- Decompression errors / tag overruns → safe abort of that file, no partial writes.
- Every error maps to a user-facing message; technical detail goes to logs.

## Persistence behavior

- Extraction records dedup by `(source_hash, source_sound_id)`; re-import
  of the same file adds nothing.

## Platform considerations

- Pure-Rust parser, no OS decoders; identical results on all platforms.
- 30 MB-class files must stream tags, not hold multiple copies in memory.

## Security implications

- Bounds-checked reads; allocation capped by declared length (max 256 MB,
  reject above); decompressed size validated against header before use;
  no indexing on file-controlled offsets without checks.

## Acceptance criteria

- [x] Reference `The Nineteenth Wave Looper.swf` (FWS v5, ~29 MB): all MP3
  `DefineSound`s extracted byte-identical, ordered, provenance recorded
  (manual validation via inventory, not CI).
  **Verified 2026-09-18: 51 extracted / 0 skipped; all decode via rodio.**
- [x] Reference `TheSeventeenthWaveLooper.exe` behaves identically through
  the `025` path (offset 819200).
  **Verified 2026-09-18: 48 extracted / 0 skipped; all decode via rodio.**
- [x] Synthetic fixtures in CI: valid FWS, CWS, multi-sound, truncated,
  unsupported-codec — all behave per spec.
- [x] Synthetic ADPCM fixture decodes to a valid WAV; local ignored fixture
  `turntable_training_looper_low_res.swf` extracts its ADPCM sounds.
- [x] JPEG2 table/image streams merge into a decodable cover; library cover
  thumbnails persist and are served to the UI; extracted audio carries ID3
  artist/album tags and the cover image.
- [x] Malformed inputs never panic, never write partial files.

## Non-goals

- `ZWS` support, Nellymoser transcoding, ActionScript, streaming sounds beyond
  MP3 `SoundStreamHead`/`SoundStreamBlock` assembly, as separate tracks.
