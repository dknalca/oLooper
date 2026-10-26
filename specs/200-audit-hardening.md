# 200 — Audit hardening

Resource and mutation constraints are recorded in ADR 0022. Executed checks and
the remaining on-device release checks are tracked in
[`docs/audit-validation-2026-10-25.md`](../docs/audit-validation-2026-10-25.md).
Two newly reproduced BPM/tag and root-scoped progress races are recorded as open
follow-up findings in [`docs/documentation-review-2026-10-26.md`](../docs/documentation-review-2026-10-26.md).
The follow-up also records source-less BPM event provenance, full-snapshot
progress-event cost, and idle-cover observers while disabled.

## Library identity and persistence

- A library switch invalidates selection/decode generations, clears UI state
  bound to old catalog IDs, and unloads the old audio source.
- Long-running library work captures the selected root before moving to a
  blocking worker; it must never apply old track IDs to a newly selected DB.
- Every extracted source group has a collision-resistant managed directory.
  Staged audio writes and user exports never overwrite an existing destination.
- Cancellation before catalog insertion removes the staged audio file.
- Metadata-only edits preserve BPM provenance. A user edit or Tap Tempo action
  explicitly confirms the numeric BPM, including when the value is unchanged;
  Serato sync writes that confirmed BPM without replacing preserved CUEs or loops.
  This is the intended invariant. The ordinary metadata-only regression passes,
  but the follow-up audit reproduced a tag-read/sync interleaving that can violate
  it; see DOC-A01.
- Metadata, tag and removal writes are serialized per library with an exclusive
  file lease plus an in-process mutex. Concurrent updates to different CUE slots
  must both persist, and a second process must not mutate the same library.
- Deletion quarantine is recorded in a durable manifest before the database row
  is removed. Reopening a library restores a pending clean-shutdown removal,
  purges completed ones, and rejects manifest paths outside the library.

## Audio engine

- Default-output monitoring is deadline-based and remains active under status
  polling. Failed/disconnected endpoints can be retried after a cooldown; stream
  callbacks are generation-scoped so an obsolete stream cannot invalidate a
  replacement route.
- Library unload, decode supersession, and decoded-cache entries are generation
  and file-identity aware. Waveform data is usable only for its current track
  and path.
- Pitch-lock buffer swaps preserve proportional play position and loop bounds;
  changing speed during a pending stretch schedules only the newest request.
- Keyboard transport commands publish their returned `PlayerStatus` to the same
  application state used by player controls and polling.

## Import and platform constraints

- Import progress events are owned by one job ID. Concurrent drops are rejected,
  cancellation stops the active job and the remaining queue, and a partial
  result carries an explicit error rather than looking complete.
- Windows Serato replacement restores an orphaned backup on the next metadata
  read or library open and reports restoration failures. Only backups whose
  header matches the missing audio format are restored. Export and import writes
  use no-clobber commits.
- Parsers, network downloads, container decompression and decode use bounded
  reads with cancellation checks, and heavy work runs outside synchronous IPC
  handlers under the shared working budget. A failed import job cannot terminate
  the worker or hide the partial report.
- Window/analysis IPC inputs are validated before allocation, division or
  indexing, so invalid sizes return an error instead of panicking.
- The frontend baseline remains macOS 11 / Safari 14.1; styles use Tailwind 3
  and import IDs have a Web Crypto fallback. Runtime validation on Big Sur is
  still required before claiming device-tested compatibility.
- Windows release builds explicitly target `x86_64-pc-windows-msvc`, verify the
  produced PE machine type, and run frontend and Rust suites before upload.

## Acceptance tests

- Long sanitized names from different sources do not share folders or bytes.
- Cancelling after staging and before insert leaves no untracked audio file.
- A manual BPM survives stale file tags; later external Serato BPM edits remain
  discoverable; title-only edits do not change BPM source/confidence.
- A replaced file at the same path misses the decoded cache; obsolete decode and
  stretch completions cannot replace newer user selections.
- Output failure/reconnect recovery is generation-safe; physical endpoint
  unplug/replug and Big Sur runtime tests are release checks.
- Cancelled partial imports are surfaced as cancelled, not completed, and do not
  overwrite another job's progress or user files. Completed track IDs and counts
  remain available in the error path.
- Simultaneous CUE-slot writes over the IPC boundary preserve every slot and do
  not alter audio bytes or saved loops.
- Reopening a library after an interrupted removal restores the quarantined file
  exactly once; paths escaping the library are rejected.
