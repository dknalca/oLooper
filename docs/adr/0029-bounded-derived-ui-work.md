# 0029 — Bound and invalidate derived UI work independently of audio

## Status

Accepted — 2026-10-29.

## Context

Playback is native and can continue independently of React. Catalog refreshes,
cover reads and drawing must not multiply accessory work or retain every image
in a large library. The performance review identifies higher-risk native
changes that require separate physical-device measurement.

## Decision

- Share an app-owned, scope-aware, bounded LRU for cover reads; load thumbnails
  by visibility and coalesce pending reads. Explicit library generation/catalog
  revisions invalidate results, including negative results.
- Bind in-memory waveform peaks to the loaded native generation and a small
  set of display resolutions. Serialize requests and drop superseded queued work.
- Schedule waveform drawing on invalidation unless playback needs animation;
  suspend painting, not transport, under full-cover/hidden UI.
- Briefly reuse a bounded set of public Tablist pages; keep library download
  counts and import admission independent.
- Do not perform a full catalog refresh merely to persist playback history.

No native audio, database schema, source-file security or import protocol changes
are included. See `specs/300-lightweight-derived-ui.md` for resource bounds and
`docs/performance-review-2026-10-29.md` for deferred work.

## Consequences

Tests can verify fewer IPC calls, bounded cache retention and no idle frame loop
without starting audio hardware. This is not proof of native performance gains.
Images/public pages may be reused within their documented TTL; external file
edits are observed on a subsequent read after expiry or explicit refresh.
An already-running native request is not interrupted. Persistent caching for
embedded peaks and native scheduling remain separate decisions.
