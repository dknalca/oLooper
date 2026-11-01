# 310 — Owned decode input and bounded native memory-copy reduction

## Scope

Reduce explicit encoded-input and PCM copies in background decode/conversion
without changing decoder selection, resulting samples, native output, scheduling
priority or the callback. This follows the resource review and ADR 0022.

## Requirements

1. Keep the borrowed `decode_bytes(&[u8])` API for callers that must retain their
   encoded bytes for hashing, persistence or conversion validation. It performs
   one owned copy only after admission to the existing transient-work slot.
2. Provide `decode_owned_bytes(Vec<u8>)` for callers already transferring input.
   Move the existing vector into Rodio/Symphonia rather than cloning it first.
   Playback/prefetch file jobs and parsed embedded sound frames use this route.
3. Both APIs retain the shared work guard. Check job cancellation before waiting
   for admission and immediately after obtaining it, before decoder setup or the
   borrowed-input copy. Existing per-packet/sample cancellation remains intact.
4. Preserve the custom ISO BMFF/M4A decoder path, gapless packet handling, audio
   layout limits, practice-duration/PCM budgets and panic-to-error boundaries.
   Transfer owned M4A input into its cursor too.
5. AAC edge trimming uses the existing start/end selection unchanged. Move the
   retained interleaved samples to the beginning of the same vector and truncate
   its logical length. Do not allocate another full PCM vector or shrink its
   capacity. This can retain spare capacity from the original decode; the decoded
   cache accounts for the vector's capacity, not just its useful sample length.
6. When MP3 conversion preserves an already-supported source sample rate, borrow
   the source PCM for the encoder instead of cloning it. Keep the existing
   remapping/resampling path and encoding settings for other sample rates.
7. Preserve regular-file validation, size/growth caps, source hashes and identity
   checks. No database, source-file writes, managed tag contract or cache budget
   policy changes are included. Capacity accounting can evict cached buffers
   sooner, without dropping the active playback snapshot.

## Regression criteria

- Borrowed and owned paths return identical PCM, channels, rate and frame counts
  for synthetic mono/stereo WAV and generated MP3.
- Both paths reject over-duration and invalid inputs; malformed M4A remains an
  error rather than a process panic.
- A cancelled decode can return while another task holds the work guard.
- Edge trimming preserves the allocation pointer and exact interleaved samples,
  including stereo; long/silent edges retain the existing behavior.
- Decoded-cache bytes include retained PCM capacity; eviction at a smaller budget
  releases the cache entry without invalidating the active playback snapshot.
- Existing embedded SWF/EXE, gapless, routing, conversion and Serato tests pass.

## Validation limits

No hardware is needed for these sample/bounds/ownership checks. They do not prove
physical-device continuity or a measured percentage reduction in process RAM.
An owned decode removes one explicit full encoded copy; other codec allocations,
retained input needed by import callers and resampling buffers still exist.
In-place AAC trimming avoids a second full PCM allocation but can retain more
memory than the previous right-sized trimmed vector. Capacity accounting can
therefore reduce the number of cached tracks; it is not a total-memory bound.
The real M4A fixture regression remains optional and requires an external sample;
this increment does not claim that ignored fixture was exercised.

No dependency changes, installations, native app bundle or release build are
required. Prefer offline tests with the existing Cargo cache and one build job.
Global memory accounting, cancellable admission queues, worker QoS, native webview
cancellation and callback/handoff changes remain separate increments.

## Validation record — 2026-10-29

- Full offline Rust suite with one build job and two test threads: **276 passed,
  zero failed, four ignored** (external fixtures), including the retained-capacity
  cache regression.
- Targeted `rustfmt --check` for the four modified Rust files and `git diff --check`
  pass. No native application bundle was rebuilt or physical audio validated.
