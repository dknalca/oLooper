# 190 — Tap tempo for BPM correction

## Scope

Let users replace a doubtful or missing BPM estimate by tapping the beat of the
selected track, using the existing manual metadata editor and persistence flow.

## User-visible behavior

- The BPM editor provides a **Tap tempo** button and a clear tap-count/status.
- Four evenly spaced quarter-note taps calculate and fill a rounded BPM value.
- Taps outside the supported 30–300 BPM interval restart the tap sequence; a
  long pause starts a new sequence. A short recent history smooths timing jitter.
- The detected value remains editable in the BPM field. Saving it uses the
  existing manual-BPM path, so later analysis does not replace it and existing
  supported Serato sync behavior is retained.
- The control works both when reviewing a low-confidence estimate and when
  entering a BPM for a track with no estimate.

## Acceptance criteria

- [x] The estimator returns 120 BPM after four taps at 500 ms intervals.
- [ ] Manual: mouse and keyboard taps populate the BPM editor while playback continues.
- [x] Jittered intervals use a robust recent median rather than a single tap
  interval.
- [x] A pause or invalid tempo range resets the tap sequence.
- [ ] Saving a tapped value persists it as manual BPM and keeps existing metadata
  synchronization behavior.
- [ ] Manual: tapping never starts or interrupts playback.
