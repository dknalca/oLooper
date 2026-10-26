# ADR 0024 — Persist source folders and reconcile by playback dependency

- Status: accepted
- Date: 2026-10-26

## Decision

Remember recursively imported folder paths and import options per library (schema
v11). Associate content hashes with their original folders before publishing import
completion, independently of whether the container was copied into the library.

Reconcile manually. Discover and hash sources before mutating the catalog; abort
on inaccessible folders or read failures. Revalidate source availability and Unix
volume identity, then commit missing-track removals and identical embedded-source
relocations under the library mutation guard. Queue new/changed inputs afterwards.

Availability follows actual playback dependencies. Surviving extracted audio and
managed source copies outlive their external originals. Reconciliation removes
missing catalog entries and playlist references, but never surviving physical
assets. Successfully imported hashes remain remembered after removal, so an
unchanged original does not recreate deliberately deleted extracted audio.

## Consequences

- Folder links survive restart and source copying, including empty folders.
- Existing tracks retain metadata and playlist identities unless their audio is
  unavailable. Changed containers can coexist with surviving extracted versions.
- Reconciliation and asynchronous imports are separate commits: cancellation or
  import failure preserves prior completed updates and reports partial results.
- Older imports need their folder imported once to establish original associations.
- No filesystem watcher is required; explicit actions reuse existing menus without
  changing the waveform or permanent collection-panel layout.

See [spec 280](../../specs/280-linked-source-folders.md) for contracts and coverage.
