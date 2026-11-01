# 0030 — Transfer owned decode input without changing DSP or admission

## Status

Accepted — 2026-10-29.

## Context

File playback jobs already own encoded bytes, but passed them to a borrowed API
that cloned them for a `'static` decoder source. Parsed embedded sound frames
have the same ownership opportunity. AAC edge trimming also allocated a second
PCM vector, and common-rate MP3 conversion cloned encoder input unnecessarily.

## Decision

Provide separate borrowed and owned decode entry points that share the same
transient-work guard and decoder dispatch. Move owned input into the decoder,
including the custom M4A path; preserve all existing layout, duration, memory,
identity, gapless and panic checks. Check cancellation around admission.

Reuse the original PCM allocation when applying existing AAC trim boundaries.
Count retained vector capacity in decoded-cache admission and eviction, preserving
the existing budget policy and the separately owned active playback snapshot.
Borrow common-rate PCM input for MP3 encoding. Do not alter sample computation,
resampling, output latency, callback behavior or worker priorities.

## Consequences

Hardware-free regressions can compare exact samples and verify allocation reuse
and cancellation. Fewer explicit allocations are justified by ownership, not by
an unmeasured claim about total RAM or dropout rates. AAC trimming retains vector
capacity rather than shrinking it; cache accounting includes that capacity and
may evict entries sooner. Borrowed import callers and resampling still need some
copies; resource caps and ADR 0022 remain in force.

See `specs/310-owned-audio-decode.md` for coverage and validation limits.
