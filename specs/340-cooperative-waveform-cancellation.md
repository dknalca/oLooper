# 340 — Cooperatively stop obsolete loaded-waveform scans

## Scope

Avoid completing a full PCM scan for a waveform whose published playback
snapshot has changed. Preserve peak values, cache format/version, frontend IPC,
audio samples, playback timing, output buffers and thread priorities.

This extends the existing path/generation rejection of completed peak jobs.
It does not add persistent embedded peak caching or a native cancel command.

## Admission and ownership

1. Preserve the persistent file-cache fast path before any snapshot/compute lock.
   A valid cache hit remains independent of engine state and needs no PCM.
2. On a miss, capture only path and load generation before waiting for the
   existing waveform compute mutex. Do not clone/pin a PCM `Arc` in a waiter.
   A request already referring to another loaded path fails before waiting.
3. After admission, reject a changed owner before another cache lookup. Validate
   again when cloning the current PCM under a short read lock. Same-path reloads
   must not silently adopt the newer generation after waiting.
4. Keep the existing single-scan compute mutex. Do not create additional workers,
   bypass decode/container work guards or change playback-generation semantics.

## Cooperative computation

- Share one peak algorithm between the existing infallible `from_buffer` API and
  an internal checked variant; do not duplicate or change production DSP math.
- Check before allocating peaks, at scan opportunities separated by at most
  65,536 visited frames, and after normalization. Empty input checks at entry.
  The budget spans bucket boundaries; short tracks with many buckets do not
  acquire a snapshot lock for every bucket or sample.
- Preserve bucket boundaries, interleaved channel summation order, max-abs
  reduction and normalization exactly. The cache algorithm version stays at 2.
- At scan checkpoints, use a short `try_read` to compare the live path/generation.
  A writer in progress is not proof of staleness: skip that check rather than
  block on the writer or falsely cancel a still-current track. Poisoned snapshot
  state fails closed.
- Confirm ownership with the existing final read before cache storage/return.
  Do not publish or store a partially computed/cancelled result. Preserve the
  `track changed` error recognized by the frontend and job-level stale metrics;
  no per-checkpoint logging or file I/O.

## Regression criteria

- Compare exact `f32::to_bits` output against an independent algorithm-v2
  reference, not just checked versus unchecked calls sharing the new core.
  Cover zero/mono/stereo/eight-channel layouts, empty/short/long inputs, zero
  sample rate, clamped bucket extremes and scans crossing checkpoint boundaries.
- Prove early, mid-scan, final and empty-input cancellation; count checkpoint
  calls by visited frames rather than bucket count.
- A queued owner retains no PCM and rejects a same-path newer generation.
- A contended snapshot writer cannot block a scan checkpoint; a changed owner is
  rejected at the next obtainable check. Exercise unload, reload and another path.
- An already obsolete path returns while the compute slot is held elsewhere.
- A current embedded scan still matches pure peaks without materializing audio;
  the existing persistent-cache hit succeeds while a snapshot write lock is held.

## Limits

The checkpoint interval bounds work between check opportunities, not elapsed
time or instantaneous cancellation. Contended checks can be skipped; final
validation can still wait for an active writer. Waiting for the compute mutex is
not made interruptible, but obsolete admitted jobs do not begin a full scan.

Ownership changes when the engine publishes/unloads a snapshot. Merely starting
a pending load while the former PCM remains current does not invalidate it.
Same-generation zoom changes and unmounts have no new native cancellation token;
frontend queueing/generation guards remain in place. Standalone byte-waveform
computation retains its existing behavior without a playback owner.

Cache identity, filesystem races, cache limits and atomic writes are unchanged;
this increment is not a redesign of persistent cache identity. Extra checks have
some overhead on current scans. No CPU/RAM percentage, native latency improvement
or physical audio continuity is asserted without measurement.

## Validation record — 2026-10-29

- Targeted formatting checks on the four affected Rust files and `git diff --check`
  pass.
- The first offline `waveform` test attempt hit its 240-second compilation timeout
  before executing tests. No passing-test result is attributed to that attempt.
- The full retry, `CARGO_BUILD_JOBS=1 cargo test --offline --manifest-path src-tauri/Cargo.toml -- --test-threads=2`,
  passes: **301 tests passed, zero failed, four ignored** (external fixtures).
  All ten new regressions pass, including bit-exact algorithm-v2 comparison and
  nonblocking ownership checks.
- No installations, dependency changes, native bundle rebuild or physical audio
  validation were required or performed for this increment.
