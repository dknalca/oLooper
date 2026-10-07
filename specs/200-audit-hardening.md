# 200 — Audit hardening

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
- Windows Serato replacement restores an orphaned backup on the next read and
  reports restoration failures. Export and import writes use no-clobber commits.
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
  overwrite another job's progress or user files.
