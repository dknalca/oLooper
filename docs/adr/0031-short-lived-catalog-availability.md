# 0031 — Scope file observations to catalog reads and hydrate Random lazily

## Status

Accepted — 2026-10-29.

## Context

Embedded tracks can share the same source path, but catalog projection checked
that path for every row. Random projected every metadata field and checked every
file before selecting a track. Persistently caching availability would require
invalidation across external changes, library roots and source relocation.

## Decision

Reuse file observations only within one catalog operation, bounded by entries
and retained path text. Fall back to real probes when full. Keep independent
playback admission and do not treat cached observations as authorization.

For Random, read lightweight scoped ID/path candidates and draw without
replacement. Check availability before hydrating metadata by primary key; recheck
the current row/scope. Defer the excluded current track until all alternatives
are unavailable. Preserve per-track weighting, including shared containers.

## Consequences

No cross-call invalidation machinery, watcher, schema migration or new SQLite
connection pool is needed. Missing files remain catalog entries. Healthy Random
draws avoid most filesystem checks and full-row allocations. The candidate vector
still scales with catalog size; mostly missing catalogs can exhaust every draw
and require additional entropy queries. This does not prove global RAM/latency
improvements or hardware continuity. Source safety and WAL remain unchanged.

See `specs/320-lightweight-catalog-reads.md` for bounds and regression criteria.
