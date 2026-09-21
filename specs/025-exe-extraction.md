# 025 — EXE Projector Extraction

## Scope

Treat `.exe` loopers as untrusted binary containers. Never execute.
Locate an embedded SWF and reuse the `020` pipeline.

## User-visible behavior

1. User drops/opens a `.exe` → app scans for embedded `FWS`/`CWS` candidates.
2. If a valid SWF is found → extraction proceeds exactly as in `020` with
   `source_type=exe` plus `exe_offset`/`exe_length` provenance.
3. If none is found → `UnsupportedExe` with a clear message; source intact.

## Supported inputs

- PE binaries (MZ header) embedding a full SWF (appended payload or resource).
  Projector layouts vary by authoring tool → no fixed offset assumed.
- Candidate validation: magic `FWS`/`CWS`, version 1–40, declared length fits
  inside the file from the candidate offset, header fully parseable.
  Largest *content* wins, ranked by declared header length (on-disk for
  `FWS`, decompressed size for `CWS`) — not by stored slice length, since a
  `CWS` slice runs to end-of-file and an early loader stub would otherwise
  outrank the real movie. Ties prefer `FWS`.

## Outputs

- Same as `020`, with `source_type=exe`.

## Failure behavior

- No MZ header → `NotAnExe`. No valid candidate → `UnsupportedExe`.
  Both state the source was not modified and suggest trying the raw `.swf`.

## Persistence behavior

- Same dedup as `020` on `(source_hash, source_sound_id)` where
  `source_hash` is of the `.exe`.

## Platform considerations

- Runs on macOS (parse-only; no Wine/VM). Identical logic on all platforms.

## Security implications

- Whole file is untrusted data: bounded scan, candidate count cap,
  allocation caps inherited from `020`. No execution, no shell-out with
  file-controlled names.

## Acceptance criteria

- [x] Reference `TheSeventeenthWaveLooper.exe` (~28.5 MB, SWF at offset
  819200): extracts the same sounds as its SWF path (manual validation).
- [x] Synthetic CI fixtures: stub + appended SWF extracts; EXE without SWF →
  `UnsupportedExe`; truncated embedded SWF → safe error, no panic/partial write.

## Non-goals

- Non-Flash installers, extraction of non-SWF resources, running projectors.
