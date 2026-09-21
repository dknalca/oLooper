# 0007 — Background audio jobs on the engine channel

## Context

`Player::load` (file read + decode) and WSOLA stretching run synchronously
on the dedicated audio thread, behind Tauri `invoke` calls. Both can take
seconds, freezing transport controls, track switching, and waveform
requests. The audio thread owns rodio's `!Send` hardware, so completions
must be applied there.

## Decision

- Heavy work (decode, WSOLA stretch) runs on throwaway worker threads.
- Every job is tagged with a monotonically increasing **load generation**
  (bumped on each `player_load` request) plus job-specific keys (speed for
  pitch jobs). Workers post typed completions (`LoadReady`, `PitchReady`)
  back through the **same** `EngineCmd` channel, so application is
  serialized on the audio thread with no extra locking.
- Application is conditional: a completion applies only if its tags still
  match current state (track generation, speed, pitch-lock flag, job id);
  otherwise it is discarded. Cancellation = supersede + discard; workers
  are never force-killed.
- `waveform_peaks` never holds the engine lock during computation: disk
  cache hit takes no lock at all; on a miss it clones `Arc<LoopBuffer>`
  under a short read lock and re-validates path + generation afterwards.
- Status carries `loading` / `load_error` / `pitch_preparing` /
  `pitch_error` so the UI can show progress without new event plumbing.

## Consequences

- Track switch and pitch toggle return instantly; previous audio keeps
  playing until a valid replacement is ready.
- At most one pending load is honored (latest generation wins); pitch jobs
  are deduplicated per (generation, speed).
- Worker panics are caught at the thread boundary and reported as job
  errors, never as stuck "preparing" states.
