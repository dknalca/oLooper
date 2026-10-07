# ADR 0021: Apply pitch speed in the live source before output resampling

**Status:** Accepted

## Context

The player routes each source through Rodio's `Sink`, then through a
`DynamicMixer` that converts each source to the device's output sample rate.
Rodio's `Sink::set_speed` changes the source's reported sample rate. The
`DynamicMixer`'s `UniformSourceIterator` then resamples that rate back to the
output clock, cancelling the audible pitch and tempo change.

## Decision

Keep the source's nominal sample rate fixed and apply the speed factor directly
to its fractional frame position. Read the shared speed factor once per output
frame and interpolate between adjacent source frames. This updates an active
source immediately without rebuilding its sink; the downstream mixer still
performs only device-rate/channel conversion.

Pitch lock remains hidden in the UI. Its existing backend remains available for
internal use, and a stretched buffer is played with the source speed set to 1x.

## Consequences

- The speed change remains responsive while audio is playing and remains
  effective across output sample-rate conversion.
- Fractional playback rates use linear interpolation; loop boundaries continue
  to wrap within the selected frame region.
- Tests verify live speed-factor updates, fractional interpolation, source-rate
  metadata, and unchanged 1x loop behavior.
