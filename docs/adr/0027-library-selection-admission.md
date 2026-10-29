# ADR 0027 — Library selection admission and activation

- Status: accepted
- Date: 2026-10-29

## Context

Library initialization and restore prepare a catalog asynchronously. Two
overlapping requests could complete out of order; preparing the log used to
change its active destination before the selected catalog was committed. A stale
frontend restore could also overwrite the result of a newer manual selection.

## Decision

- Give each backend init/restore request a generation at admission. Only the
  newest admitted request may activate, even if an older preparation completes
  later. A failed newest request leaves the existing active catalog selected;
  it does not let an older in-flight request take over.
- Prepare the library and log destination without switching the global log.
  Under the admission gate, unload audio, cancel jobs owned by the previous root,
  activate the prepared log and replace the selected catalog. The gate serializes
  these activation steps against later admissions.
- The UI assigns its own request generation and ignores superseded responses,
  including errors and local preference writes. Backend generation is based on
  command admission order; it does not assert ordering guarantees beyond it.

## Consequences

- A superseded command returns an explicit error; its caller must not surface an
  obsolete result as the current library. Preparation can still create/open the
  requested library and its log file; it cannot activate them after supersession.
- The guard and headless UI tests cover delayed/out-of-order completion. Native
  multi-platform and physical-device testing remain separate checks.
