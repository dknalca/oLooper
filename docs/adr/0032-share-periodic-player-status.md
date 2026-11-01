# 0032 — Share periodic player-status observations, not command snapshots

## Status

Accepted — 2026-10-29.

## Context

Player and the audio dialog each serialized their own periodic reads, but could
still issue overlapping requests at 250/100 ms. A cached or globally shared status
promise could accidentally replay a snapshot that predates a command, new track
owner or reopened dialog. Explicit load waits and command responses also have
their own freshness and deadline contracts.

## Decision

Use one subscription-driven periodic stream for those two consumers. Deliver
fresh reads at the fastest active cadence, preserve delayed initial activation,
and allow only one stream read in flight. Capture receiver ownership before each
read. New subscriptions do not inherit a read that began before they joined;
removed subscriptions cannot receive a late completion.

Retain no last-value cache and do not route commands or one-shot reads through
the stream. Keep the typed native command wrapper in `src/tauri.ts`; the stream
delegates to that wrapper without changing IPC or native audio behavior.

## Consequences

Overlapping periodic consumers no longer add independent read loops. A slow native
read cannot accumulate timer ticks; no subscribers means no scheduled polling.
Existing ownership, terminal-status payloads and transient-error retries remain.

All ready consumers receive the same object at the fastest cadence, rather than
being notified by separate timers. App's high-frequency state/render structure is
not redesigned. Explicit reads can still overlap the stream, and a stalled stream
read must settle before the next periodic read starts. Neither total IPC
single-flight nor physical audio continuity is claimed.

See `specs/330-shared-player-status-polling.md` for lifecycle rules and coverage.
