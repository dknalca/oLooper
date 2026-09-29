# 000 — Product Foundation

## Scope

Cross-platform desktop app (macOS 12 verified first) for DJs/turntablists:
extract practice loops from legacy `.swf` / Flash-projector `.exe`,
practice with a persistent local library, prepare cue/loop metadata
(Serato-write explicitly out of MVP).

## User-visible behavior (MVP)

1. Drop/open a `.swf` → app discovers embedded audio → extracts to library → each loop playable.
2. Drop/open a `.exe` projector → app locates embedded SWF → same pipeline; unsupported EXEs fail with a clear message.
3. Drop supported audio → copied into the library and ready to practice.
4. Library persists across restarts; missing/moved files reported, never silently duplicated.
5. Infinite (perceptually gapless) looping with scrolling waveform, BPM and cue/slot controls.
6. Keyboard shortcuts for hands-free practice: Space (play/pause), S (stop), arrows (seek), L (loop toggle).
7. Four numbered CUE controls per track; cues 2–4 persist to SQLite and cue 1
   always returns to track start.
8. Native OS file dialogs for importing SWF/EXE/audio and selecting library root.
9. File/Edit application menus, plus dark UI with Tailwind CSS: two-pane library,
   transport controls, and track-management menus.

## Inputs / outputs

- Inputs: `.swf` (FWS/CWS), `.exe` (PE projector with embedded SWF), `.wav`/`.mp3` (AIFF deferred). All untrusted.
- Outputs: extracted audio under `<library>/<looper-name>/`, custom audio in
  `Custom Loops/`, and catalog/derived metadata in SQLite.

## Failure behavior

- Malformed/unsupported inputs fail safely with: what failed, confirmation the source was not modified, next action. No raw Rust errors in UI; detail in logs.

## Persistence behavior

- SQLite is catalog + derived metadata (migrations explicit); audio files are the canonical audio. Re-imports dedup by hash; user edits (BPM/cue/loop) never overwritten by re-analysis.

## Platform considerations

- MVP verified on macOS 12. Architecture stays cross-platform (no macOS-only core logic). `.app`/`.dmg` self-contained: no Rust/Node/FFmpeg required of end users.

## Security implications

- Never execute imported `.exe` or Flash content. Bounds-checked parsing, allocation limits, sanitized paths, atomic validated writes, least-privilege Tauri capabilities.

## Acceptance criteria

- [x] SWF from `loopersFlash/` extracts, persists, loops with waveform.
- [x] EXE from `loopersFlash/` extracts via embedded SWF or fails clearly, source intact.
- [x] Restart preserves library without re-analysis or duplication.
- [x] Dropped WAV plays immediately with editable cue/loop.
- [x] Clean-macOS install runs without dev dependencies.
- [x] Keyboard shortcuts control transport and loop enablement without mouse.
- [x] 4 loop slots per track persist across sessions.
- [x] Native file pickers for import and library init.
- [x] Dark UI with sidebar layout, context menus, track stats.

## Non-goals (MVP)

- Serato metadata writing; low-latency pro audio; stems; manual loop-boundary editing; Flash execution/emulation; cloud processing.
