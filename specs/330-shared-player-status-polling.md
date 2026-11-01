# 330 — Share periodic player-status reads without caching command state

## Scope

Coordinate the periodic status consumers in `Player` and `useAudioRoutingSession`.
Reduce duplicate native reads without changing Rust, IPC contracts, transport
commands, load waits, Random timing, output buffers or audio processing.

This is deliberately not a global status cache or a replacement for all status
reads. Explicit reads during routing, startup, keyboard error recovery and load
waits remain independent, including their existing deadlines and ownership checks.

## Scheduling

1. `Player` requests 250 ms polling only while playing, loading or preparing pitch,
   including background work while paused. Its first read remains delayed.
   The audio dialog requests an immediate first read and a 100 ms cadence while
   open, including output tests.
2. Ready consumers share the same fresh status object at the fastest requested
   cadence. Thus Player can receive more frequent updates while the dialog is
   open; that dialog already publishes its status to App at the faster cadence.
   No extra independent 250 ms loop is retained during shared operation.
3. Schedule from completion, not from a fixed-rate interval. One shared read may
   be pending at a time, with no timer-tick backlog or overlap. Use monotonic time
   and round future timer delays up to avoid sub-millisecond early retries.
4. Preserve each delayed consumer's initial deadline. Its first activation may
   bring one shared read forward; subsequent reads follow the fastest cadence.
   Recompute scheduling when consumers join or leave; retain no timer when empty.
5. A consumer joining an already-started read must not receive that old result.
   After the read settles, start a fresh one when the new consumer is due. This
   also applies to closing/reopening with the same callback function.

## Ownership and failures

- Prepare each synchronous receiver before its native read. Player captures its
  existing track/open-generation/native-generation/path owner there and checks it
  before publishing, not after the result arrives.
- Unsubscribe is idempotent. Check subscription identity before every delivery,
  even if another receiver removes it. Late completions do not call a closed
  meter session or an unmounted Player, nor revive a removed subscription.
- The IPC invoke already in flight is not cancelled. If it stalls, later shared
  periodic reads wait for it to settle rather than creating a parallel backlog.
  There is no new native timeout; explicit reads and commands are not queued here.
- Match existing serial-poll behavior for transient IPC failures: retry on the
  next scheduled attempt. Do not replay the last successful status as if fresh.
- Pass the complete status DTO unchanged, including decode/stretch completion,
  `load_error`, `pitch_error`, `output_error`, generation, position and levels.
  Isolate a failing preparation or synchronous receiver from the others.
- Do not retain status values across idle periods, add a visibility pause, or
  create global arbitration between command responses and status snapshots.

## Regression criteria

- Preserve first-read delay and prove no work without subscriptions.
- With instant mocked reads, shared steady-state 100/250 ms consumers require
  ten reads in one second, not two additive loops; removing the fast consumer
  restores the 250 ms cadence. Real Player/audio-hook integration must show ten,
  then four, then zero reads after closing/unmounting.
- A slow read never overlaps, including consumers joining while it is pending;
  elapsed ticks do not become queued requests.
- Check close/reopen, removal before/during notification, idle restart, ownership
  changes, transport errors, failed consumers, wall-clock jumps and timer bounds.
- Player continues polling paused background work through the terminal status,
  displays pitch errors, and ignores old-owner/unmounted completions.
- Preserve existing audio-dialog stop/resume, output tests and late-meter guards,
  and existing Random, keyboard, load-wait and waveform regressions.

## Limits

Counts above are automated request/scheduling evidence, not native CPU/RAM or
physical audio-continuity measurements. One-shot reads can still overlap these
periodic reads. The dialog opening read and 150 ms load waits are not coalesced.
App still owns playback status; selective render subscriptions and separating
high-frequency position/levels from general renders are separate increments.

## Validation record — 2026-10-29

- Full frontend suite with two workers: `pnpm exec vitest run --maxWorkers=2` —
  **347 tests pass in 66 files**, including 22 new polling/lifecycle regressions.
- `pnpm run typecheck`, `pnpm run build` and `git diff --check` pass.
- Real React consumers with mocked IPC show ten reads in a steady one-second
  shared window, four after closing the audio session and zero after unmounting.
- No Rust/dependency changes, native bundle rebuild or physical audio validation.
