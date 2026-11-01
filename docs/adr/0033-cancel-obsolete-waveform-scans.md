# 0033 — Cancel obsolete waveform scans at bounded nonblocking checkpoints

## Status

Accepted — 2026-10-29.

## Context

Loaded-waveform jobs scanned PCM outside the audio lock, but only checked path
and generation after finishing. Old scans could continue consuming CPU after a
new playback snapshot was published. A queued same-path request captured its
generation only after admission, while frequent blocking checks could instead
introduce avoidable contention with audio-state writers.

## Decision

Capture only waveform-owner identity before the existing compute admission;
recheck after waiting and before cloning PCM. Add cooperative checks before,
during and after the peak scan, budgeting by visited frames across buckets.

Use nonblocking snapshot reads at scan checkpoints, skipping an active writer
without assuming the track changed. Retain final strict validation before cache
storage/return. Preserve the infallible pure API and share its exact peak math
with the checked variant. Keep cache algorithm version 2 and the lock-free
persistent-hit fast path.

## Consequences

Obsolete scans can release their compute slot and PCM earlier without changing
audio samples or playback timing. Waiters retain identity, not old PCM. Checks
add bounded-frequency overhead and provide no wall-clock cancellation guarantee.
There is no native zoom/unmount abort token, persistent embedded cache, scheduling
priority change or new memory budget. Existing native and frontend ownership and
filesystem protections remain necessary.

See `specs/340-cooperative-waveform-cancellation.md` for regression criteria and
the distinction between check opportunities and physical-device validation.
