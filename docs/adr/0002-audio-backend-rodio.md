# ADR 0002 — Audio backend: rodio first, low latency deferred

- Status: accepted
- Date: 2026-09-18

## Context

MVP needs reliable practice playback with perceptual-gapless looping.
Pro-grade low latency is not required yet (explicit user decision).

## Decision

- Start with `rodio` (simple, cross-platform, bundles decoders).
- Native/audio layer owns timing; UI only interpolates position.
- Do not reopen the file per loop iteration; loop in the audio layer.

## Consequences

- Faster MVP; gapless is "perceptual", latency not guaranteed.
- If real bottlenecks appear, revisit via new ADR (e.g. `cpal`-based engine).
  Design keeps the swap point behind the playback module boundary.
