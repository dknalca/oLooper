# 000 — Product Foundation

## Scope

Cross-platform desktop app (macOS 12 verified first) for DJs/turntablists:
extract practice loops from legacy `.swf` / Flash-projector `.exe`,
practice with a persistent local library, prepare cue/loop metadata
(Serato-write explicitly out of MVP).

## User-visible behavior (MVP)

1. Drop/open a `.swf` → app discovers embedded audio → extracts to library → each loop playable.
2. Drop/open a `.exe` projector → app locates embedded SWF → same pipeline; unsupported EXEs fail with a clear message.
3. Drop WAV/MP3 → immediately practicable with default cue + loop.
4. Library persists across restarts; missing/moved files reported, never silently duplicated.
5. Infinite (perceptually gapless) looping with scrolling waveform, BPM/cue/loop editable.

## Inputs / outputs

- Inputs: `.swf` (FWS/CWS), `.exe` (PE projector with embedded SWF), `.wav`/`.mp3` (AIFF deferred). All untrusted.
- Outputs: extracted audio as normal files under configurable library (`Loopers/`, `Custom Loops/`); catalog + derived metadata in SQLite.

## Failure behavior

- Malformed/unsupported inputs fail safely with: what failed, confirmation the source was not modified, next action. No raw Rust errors in UI; detail in logs.

## Persistence behavior

- SQLite is catalog + derived metadata (migrations explicit); audio files are the canonical audio. Re-imports dedup by hash; user edits (BPM/cue/loop) never overwritten by re-analysis.

## Platform considerations

- MVP verified on macOS 12. Architecture stays cross-platform (no macOS-only core logic). `.app`/`.dmg` self-contained: no Rust/Node/FFmpeg required of end users.

## Security implications

- Never execute imported `.exe` or Flash content. Bounds-checked parsing, allocation limits, sanitized paths, atomic validated writes, least-privilege Tauri capabilities.

## Acceptance criteria

- [ ] SWF from `loopersFlash/` extracts, persists, loops with waveform.
- [ ] EXE from `loopersFlash/` extracts via embedded SWF or fails clearly, source intact.
- [ ] Restart preserves library without re-analysis or duplication.
- [ ] Dropped WAV plays immediately with editable cue/loop.
- [ ] Clean-macOS install runs without dev dependencies.

## Non-goals (MVP)

- Serato metadata writing; low-latency pro audio; stems; auto loop-boundary detection; Flash execution/emulation; cloud processing.
