# 290 — Timed Random at the nearest loop ending

Status: implemented and included in the updated v0.8.0 release build.

## Behavior

Automatic Random treats its chosen interval as a target, and changes after the
complete lap whose ending is nearest to it. The nearest ending may be before or
after the requested time. Only future endings are candidates; an exact tie uses
the earlier one, and at least the current lap must finish.

For a 2-minute interval starting at the loop's beginning:

| Effective lap length | Chosen ending |
| --- | --- |
| 59 s | 2 laps, 1:58 (not 2:57) |
| 41 s | 3 laps, 2:03 |
| 70 s | 2 laps, 2:20 |
| 80 s | 1 lap, 1:20 (tie with 2:40) |
| 300 s | 1 lap, 5:00 (no completed earlier lap exists) |

- Use the active practice region and actual current position, not full-file
  duration if a smaller loop is set.
- Unlocked pitch uses region duration divided by playback speed. With pitch lock,
  native status already describes stretched PCM, so do not apply the rate twice.
- The countdown shows the chosen ending. Position/status polling recomputes the
  plan without restarting its interval. Speed, seeks and loop edits replan it.
- Pausing freezes the countdown; resuming continues the remaining interval.
  A manually loaded track starts a fresh interval. Decode/pitch preparation do
  not trigger a mid-track fallback while status is changing.
- Without looping enabled, the current region's one available ending is used.
  With no loaded audio, the existing ordinary interval can start a random track.
- Manual Random/R remains immediate, including when a timed change is queued.
- Disabling Random or changing its interval aborts an armed automatic request.

## Ownership of timing

The frontend computes the nearest end and starts preparation shortly beforehand:
one second of lead, limited to half a lap for short loops. Existing Random
prefetch supplies decoded candidates where possible. The countdown continues
while that request waits.

The timer never cuts the source. `AudioLoadRequest.at_loop_end` retains at most
one prepared buffer in the engine, and arms an atomic gate on the current source.
`LoopRegion` finishes every channel of its final frame before exhausting and
posting `LoopBoundaryReached`. The engine validates both request and source load
generations, rechecks file identity, commits and starts the prepared audio without
waiting for UI polling.

If decoding is too late for the selected ending, continue the current source and
use the first complete ending after the buffer becomes ready. Never cut a lap
in order to compensate for decoding delay. If the target disappears/changes,
report the error and preserve/restart the previous source instead.

Native Pause/Stop/Seek/loop/rate edits, a newer load, unload, and the explicit
cancel command clear an armed handoff. Cancelled decoder results and boundary
notifications must not replace a newer track. Cancelling a boundary request does
not cancel unrelated manual loads.

## IPC and persistence

- `player_load_library_track` accepts optional `at_loop_end` (default false).
- `PlayerStatus.boundary_pending` distinguishes a prepared boundary wait from
  active decoding (`loading`); transport stays usable while waiting.
- `player_cancel_boundary_load` cancels only boundary-owned pending work.
- `RandomSwitchOptions` transports `atLoopEnd` and an AbortSignal within React;
  the signal is not serialized over IPC. App handles aborts before and after
  admission, and keeps the existing newest-load-generation guard.
- No catalog migration or persistent setting changes.

## Verification

Synthetic tests cover nearest endings, ties, practice regions/position, pitch
lock/unlocked rate, pause/resume, live speed changes, countdown stability, manual
override and disabling an armed request. Native hardware-free tests cover stereo
frame completion, one-shot boundary notification, disarming without ending the
old loop, late decoder cancellation, and a full mixer-to-engine prepared handoff.

Native audio-device/driver transition latency still requires listening tests.
These automated tests verify source boundaries, not a universal zero-gap claim
across devices or different sample rates.
