# Codebase and maintenance guide

This guide is an orientation map for contributors, not a replacement for the
feature specifications or architecture decisions. For product behavior, see
[`specs/`](../specs/); for decisions and their rationale, see [`docs/adr/`](adr/).
Historical audit reports describe the state at their date and may contain
findings that were subsequently fixed; check their follow-up sections and release
notes before treating them as current.

The [2026-10-28 readability review](readability-review-2026-10-28.md) records
the scope, corrections, remaining large modules and validation limits.
The [2026-10-29 quality baseline](code-quality-baseline-2026-10-29.md) documents
reproducible advisory metrics and their limitations.

## Repository map

| Location | Responsibility |
| --- | --- |
| `src/App.tsx` | Composition and coordination of library selection, playback, MIDI and dialogs. |
| `src/components/` | React views: `Sidebar` for library navigation, `Player` and `Waveform` for practice, `ImportBar` for imports, and settings/catalog dialogs. |
| `src/hooks/` | Keyboard shortcuts, modal focus and idle-cover lifecycle. |
| `src/*.ts` | Typed IPC (`tauri.ts`) and focused helpers for preferences, MIDI, imports and Random playback. |
| `src-tauri/src/lib.rs` | Tauri command registration, app state and the import worker. |
| `src-tauri/src/library/` | SQLite catalog, managed files, Serato metadata, linked folders, BPM and recovery. |
| `src-tauri/src/player/` | Decode, playback, loop boundaries, hardware output, caching and engine thread. |
| `src-tauri/src/import/` | SWF/EXE parsing and embedded sound extraction; projectors are never executed. |
| `src-tauri/src/analysis*.rs`, `autoloop.rs`, `waveform.rs` | Tempo, suggested practice loops and waveform analysis. |
| `src-tauri/src/tablist.rs`, `midi*.rs` | Remote catalog/download integration and MIDI input/output or map files. |
| `scripts/`, `.github/workflows/` | Local build/packaging, dependency audit and CI/release automation. |

The largest modules still combine several concerns. Prefer extending an existing
small domain module where it fits; avoid moving intertwined audio-thread or
filesystem code solely to reduce line counts without regression tests.

## Request and state flow

### UI and IPC

`src/tauri.ts` defines the TypeScript DTOs, commands, dialog wrappers and event
subscriptions. Their names and payloads must match Rust commands registered in
`src-tauri/src/lib.rs` and the Rust serialized types. `ImportBar.tsx` directly
owns its webview drag/drop subscription; it is the current exception to the
wrapper convention. `ownSubscription` handles registration completing after an
effect has already been cleaned up.
`src/mixedImport.ts` runs mixed SWF/EXE/audio selections in order for both menu
and drag/drop, while `ImportBar` owns the active job, cancellation and UI state.
`src/containerImport.ts` accumulates container and linked-folder rescan results,
preserving their distinct error-counting rules and library-change handling.
`src/trackMetadata.ts` validates editor drafts and manual BPM confirmation before
`Sidebar` saves them; asynchronous results remain guarded by library ownership.
`src/tablistCatalog.ts` holds catalog count matching and random-page selection;
backend Tablist URL validation remains the security boundary.
`src/midiMaps.ts` validates portable and stored assignments separately from
legacy preference recovery; duplicate control checks apply when rebinding too.
`src/coverGeometry.ts` contains pure cover fit/origin calculations; the idle
cover hook and overlay still own wake-event handling and animation lifecycle.
`src/libraryTrackLoad.ts` waits for a sidebar load and validates its playback
path; Sidebar must check selection and library ownership after the async handoff.
Library empty/deletion dialogs and player CUE/audio controls are presentation
components: the Sidebar and Player retain ownership of catalog and audio writes.
`src/audioDeviceOptions.ts` and `AudioOutputControls` derive and display output
capabilities; `AudioSettingsDialog` remains responsible for applying a route.

Track IDs are local to a library. A root change can reuse the same numeric ID;
asynchronous work must retain and check the owning root/generation, not just the
ID. Player loads, CUE operations, catalog refreshes and BPM progress use
different ownership checks; preserve them when changing their effects.

### Import and persistence

An import command enqueues work and does **not** mean that it has completed.
The single `olooper-import` worker opens its own library connection. The frontend
wait helpers subscribe before enqueueing, identify the job, and consume its final
`olooper:import-progress` event. A failure can carry a partial report: already
imported tracks must still be reflected in the UI. Linked-folder rescans use
the same import machinery after reconciliation.

The selected library root owns `olooper.db`, managed audio/covers, optional
source copies and derived caches. SQLite uses WAL and separate connections for
worker/read concurrency. A playlist stores ordered track IDs; it does not copy
audio. Extracted/custom tracks use managed audio files; source-backed tracks use
`embedded:<id>` playback keys and decode the referenced SWF/EXE, which may be an
original external file or an opt-in managed copy. Load library tracks by ID so
the backend can resolve the correct source.

For managed audio, file tags are the source of truth for editable CUEs. CUE 1
is fixed at the beginning, and existing Serato saved loops must be preserved;
source-backed tracks expose only fixed CUE 1. Metadata writes, conversion and
deletion must retain their serialization, validation and recovery guarantees.
The `library/operations.rs` lease and mutation guard coordinate writers;
`library/recovery.rs` handles interrupted quarantine operations. Do not delete
external SWF/EXE or custom-audio originals when removing catalog entries.

### Playback and resources

`player::Engine` owns audio output on a dedicated thread; `EngineClient` sends
commands across the thread boundary. Decoding and pitch preparation are separate
work, and generation checks prevent obsolete results from replacing newer loads.
The native loop source, not a UI timer, commits a prepared timed-Random switch at
the boundary. Waveform computation uses decoded snapshots and a bounded
persistent cache under `<library>/.olooper-cache/waveforms/`.

`memory.rs` supplies adaptive cache budgets and a shared gate for heavy work.
Cache budgets are not a limit on the total process memory: active playback,
in-flight work and the WebView also retain memory. SWF/EXE, MIDI maps and audio
are untrusted input; preserve the existing bounds, cancellation, path validation
and atomic/staged write checks.

## Working safely

- Use Node 24, pnpm 12.9.1, Rust 1.89 or newer and the committed lockfiles.
- Install with `pnpm install --frozen-lockfile`; run `pnpm tauri dev` for the app.
- Frontend checks: `pnpm run typecheck`, `pnpm test`, and `pnpm run build`.
- Advisory inventory: `pnpm run quality:baseline` (not a pass/fail quality gate).
- Rust checks: `cargo test --manifest-path src-tauri/Cargo.toml --locked`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, and
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`.
- The ignored fixture tests need external samples; see `AGENTS.md` and the
  relevant test annotations. Never commit user samples or generated libraries.
- For behavior changes, update the relevant spec and add a regression; add an
  ADR when making a lasting architectural decision. Keep Rust DTOs and
  `src/tauri.ts` synchronized.
- Builds, unit tests and headless tests are not evidence of physical audio/MIDI,
  native drag/drop, accessibility or long-session validation. Record those
  separately when they are actually performed.

## Maintenance priorities

1. Keep the IPC, ownership and persistence invariants above visible at module
   boundaries, especially when adding asynchronous operations.
2. Split large components and modules incrementally around cohesive, testable
   responsibilities. Preserve tests for cancellation, stale results, staged
   writes, real-time audio and migration before moving code.
3. Follow up the build-time `block-buffer` advisory and remaining Serato/log
   replacement races; see [the 2026-10-29 remediation](audit-remediation-2026-10-29.md).
4. Prefer comments explaining *why* an invariant or platform workaround exists;
   avoid comments that merely restate the next line or imply guarantees the code
   does not provide.
