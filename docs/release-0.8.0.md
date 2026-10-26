# oLooper v0.8.0

## Highlights

- Linked recursive SWF/EXE folders and manual rescans; preserve surviving
  extracted audio and managed copies while removing only missing dependencies.
- Duration-aware 4/4 BPM suggestions, Half/Detected/Double editing, and cancellable
  looper/playlist/library reanalysis with protection for confirmed and file BPMs.
- Compact 44 px library rows, single-line BPM, smaller loop names, and the
  My Library / Discover switcher in the collection-pane header.
- Native macOS Preferences (`⌘,`) and an optional idle-cover display with a
  persistent wait-time selector (1–60 minutes, five-minute default).
- Next/Random prefetch, MIDI map files/presets, bounded decoding/import memory,
  persistent waveform-cache limits, library recovery and startup-quote centering.

## Follow-up corrections before release

DOC-A01–DOC-A06 from the [documentation audit](documentation-review-2026-10-26.md)
are corrected in this release:

1. **Manual BPM precedence:** catalog confirmation and a durable pending-sync
   marker commit together. Intervening tag/CUE reads cannot replace a pending
   correction with old TBPM. Successful tag sync/CUE writes clear the marker;
   subsequent real external tag edits remain readable. Failed sync leaves the
   pending correction recoverable across restart.
2. **CUE independence:** CUE edits, legacy migration and explicit sync do not write
   automatic catalog BPM into an otherwise untagged audio file. Existing external
   BPM and confirmed corrections remain supported.
3. **Library ownership:** progress handlers reject root/generation changes before
   passive cleanup, and App checks the owner again before applying updated tracks.
4. **Provenance:** the Serato IPC snapshot includes effective catalog BPM source
   and confidence under the mutation guard. Player forwards them; legacy events
   without provenance preserve the row's existing source/confidence.
5. **IPC cost:** full progress emission is limited to one snapshot per 150 ms plus
   the exact terminal report; status remains current. Completion refreshes the
   active catalog track to account for coalesced intermediate changes.
6. **Idle resources:** no activity observer/listeners are installed while the
   cover option is disabled, including after toggling it off.

Regression coverage includes stale-tag interleaving, CUE writes followed by
reanalysis, snapshot serialization, root-switch layout-effect events, Player BPM
provenance, 2,000 same-time progress attempts, and disabled-hook resource cleanup.

Local pre-publication checks: 103 frontend tests; 242 Rust tests passed and four
fixture tests ignored; TypeScript, Rustfmt and Clippy clean. pnpm audit found no
known vulnerabilities; the OSV host graph audit found zero actionable advisories
across 368 registry packages (six maintenance notices). A focused regression also
reopens the library between manual confirmation and stale-tag read.

## Compatibility and validation boundaries

- Catalog schema v11 migrates automatically; previous app versions cannot open
  the upgraded catalog. Keep the same app version on machines sharing a library.
- Build requirements: Node 24, pnpm 12.9.1, Rust >=1.89. End users do not need them.
- macOS Universal 2 (deployment target 11.0) and Windows x64 packages are built
  from the release tag in GitHub Actions. macOS package is unsigned/unnotarized.
- DOC-A07 remains a conditional synthetic delayed-click case requiring native
  WebKit/touch validation. Physical audio/MIDI routing, long-running performance,
  Big Sur and additional hardware acceptance remain separate from automated CI.
