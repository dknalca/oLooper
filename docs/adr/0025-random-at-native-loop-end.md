# ADR 0025 — Quantize timed Random and commit at native source endings

- Status: accepted
- Date: 2026-10-26

Choose the future loop ending nearest to the requested Random interval, allowing
an earlier ending and preferring the earlier lap on ties. Use the current region,
position and effective playback speed rather than rounding up to the next lap
after the target time.

A WebView timeout only starts preparation. A bounded, generation-owned prepared
load waits behind an atomic gate shared with `LoopRegion`. Once the old region
has returned its complete final frame, it notifies the engine, which commits and
starts the ready source without a WebView round trip. A slow decode may defer
the change to a later complete ending but cannot truncate the old loop.

Separate `boundary_pending` from `loading` so transport remains usable. Manual
Random and ordinary loads supersede a timed request; pause/seek/loop/rate edits,
unload and explicit cancellation clear it and invalidate late completions. Keep
the existing one-decoder/one-prepared-slot bounds and revalidate file identity
before swapping. The audio callback performs no filesystem access or decoding.

This avoids pretending that browser timers or status polling can enforce an
audio endpoint. Device buffering may still introduce transition latency; no
sample-rate/channel-independent gapless cross-track guarantee is made.

See [spec 290](../../specs/290-random-loop-boundaries.md).
