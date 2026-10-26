# ADR 0010 — Bounded parallel audio preparation during import

- Status: superseded in part by [ADR 0022](0022-audit-resource-and-library-write-bounds.md)
- Date: 2026-09-27

The 2026-10-25 audit replaces the parallel worker count below with one sound
prepared at a time under a shared memory guard. Ordered commits, PCM reuse and
the single import queue remain in effect. The original decision follows for
historical context.

## Context

SWF/EXE looper imports decode each extracted sound and estimate its BPM. This
work is CPU-heavy and the import worker previously performed it serially, so
large loopers took a long time even though their sounds are independent.

## Decision

- Prepare each small batch of sounds with scoped worker threads. The number of
  workers is limited to `min(available_parallelism, 4)` and each batch holds no
  more than that many decoded buffers.
- Each task only decodes/normalizes audio and estimates BPM. File validation,
  atomic writes, deduplication, SQLite writes and progress callbacks stay on the
  import worker thread and are applied in original sound order.
- Reuse each decoded PCM buffer for gapless trimming and BPM analysis instead of
  decoding MP3 bytes a second time.
- Preserve the existing single import queue: separate import jobs remain
  sequential, cancellation is checked before batches and while committing them.

## Consequences

The worker-count and peak-memory statements below describe the original
2026-09-27 decision only. Current preparation is sequential under ADR 0022.

- Multi-core systems can decode and analyze several tracks concurrently without
  opening concurrent SQLite writers or changing library order.
- Single-core systems and small jobs retain bounded execution and output order.
- Peak memory grows with at most four decoded buffers per preparation batch.
- A worker failure is returned as a per-sound error instead of panicking the
  import queue.
