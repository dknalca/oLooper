# ADR 0018 — Persist source-looper sidebar order

- Status: accepted
- Date: 2026-10-06

## Context

Looper groups are derived from track rows, so ordering them only in frontend
state would be lost on restart and would be overwritten when the library reloads.

## Decision

- Store the user's ordered source hashes in a separate `looper_order` SQLite
  table. The track/source group model remains unchanged.
- New groups without a saved position appear after ordered groups, in their
  original import order.
- Reordering validates that the request contains every current group exactly
  once; it changes no track metadata, path, or audio file.

## Consequences

- Library schema v8 adds the order table transactionally.
- Removing groups can leave stale order rows; list operations ignore them and
  reorder operations rewrite only current groups.
