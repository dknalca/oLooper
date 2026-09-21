# 035 — Loop Fidelity and Diagnostics

## Scope

Exact-fidelity looping with diagnostic instrumentation for discontinuity detection. Extends the player spec (030) with sample-accurate loop representation, discontinuity measurement, and classification of loop quality.

## Principle

Fidelidad exacta: never invent samples, no crossfade, no smoothing, no modification of audio content. Only choose better loop boundaries on the already-decoded PCM samples.

A loop is represented internally as a frame interval:

- `[start_frame, end_frame)` — start included, end excluded.
- On reaching `end_frame`, the next frame must be exactly `start_frame`.
- Critical loop boundaries are never calculated via milliseconds during playback; ms are for presentation/UI only.

## Phase 0: Contract and Diagnostics

Objective: determine whether a discontinuity originates from the engine, incorrect loop limits, or MP3 material.

### Instrumentation per active loop

Each time a loop is activated, record:

| Field | Description |
|-------|-------------|
| `track_id` | Identifier of the loaded track |
| `sample_rate` | Audio sample rate |
| `channels` | Number of channels |
| `start_frame` | Loop start frame |
| `end_frame` | Loop end frame |
| `loop_length_frames` | `end_frame - start_frame` |
| `start_ms` | Start in milliseconds (presentation only) |
| `end_ms` | End in milliseconds (presentation only) |
| `jump_amplitude` | Discontinuity amplitude at junction |
| `jump_slope` | Discontinuity slope at junction |
| `codec` | Decoder used (MP3, WAV, ADPCM) |
| `seek_samples` | Samples consumed by seek |
| `trimmed_leading` | Leading samples trimmed |
| `pitch_lock` | Whether pitch lock is active |
| `speed` | Playback speed percentage |

### Discontinuity measurement

```
jump_amplitude = abs(sample[end_frame - 1] - sample[start_frame])

jump_slope =
  abs(
    (sample[end_frame - 1] - sample[end_frame - 2]) -
    (sample[start_frame + 1] - sample[start_frame])
  )
```

For stereo, compute per channel and take the worst value (not a mix that could hide a click in one channel).

### Classification

| Class | Condition |
|-------|-----------|
| Continuous union | Both amplitude and slope are low |
| Probable click | Amplitude or slope is high |
| Real gap | Iterator stops producing samples, restarts the sink, or skips frames |
| Non-circular material | No nearby boundary exists where both parts join cleanly |

## Phase 1: Normalize the Engine to Frames

Currently the player stores start/end in milliseconds and converts repeatedly via `ms_to_frames`. This allows rounding errors, especially with sample rates not divisible by 1000 and after WSOLA.

### Model change

```rust
enum LoopSource {
    Manual,
    Automatic { confidence: f32 },
}

struct LoopRegionState {
    start_frame: usize,
    end_frame: usize,
    enabled: bool,
    source: LoopSource,
}
```

### Persistence

- SQLite may continue exposing `loop_start_ms` and `loop_end_ms` for visual compatibility.
- Add `loop_start_frame` and `loop_end_frame`, or compute them once on load and persist on edit confirmation.
- ms→frame conversion only when importing legacy data or when the user types a temporal value.
- Playback, cue, seek, validation, and looping use frames.

### Validation rule

```
0 <= start_frame < end_frame <= total_frames
```

### Speed changes

Without pitch lock: the frame interval does not change. Playback speed changes, not musical position within the buffer.

With pitch lock: the active buffer may have different length. Define a single transformation between original and stretched timeline:

```
active_frame = original_frame * active_total_frames / original_total_frames
original_frame = active_frame * original_total_frames / active_total_frames
```

This transformation must be used in: loop start/end, cursor, seek, cues, waveform, and visible time values. No ad-hoc conversions scattered across `seek`, `set_loop`, `cmd_pitch_ready`, and cue controls.

## Phase 2: Zero Crossing Always

Objective: when creating or moving boundaries, choose the sample closest to the requested position that reduces discontinuity without modifying audio.

### Search window

Initial window: ±10 ms

| Sample rate | Window (frames) |
|-------------|-----------------|
| 44.1 kHz | ±441 |
| 48 kHz | ±480 |

### Algorithm per boundary

1. Convert requested position to frame.
2. Search for zero crossings within the window.
3. For each candidate, compute local energy, residual amplitude, and slope.
4. Select the candidate closest to the pointer with the best score.
5. Always respect `start_frame < end_frame`.
6. For an end boundary: evaluate circular continuity against the current start.
7. For a start boundary: evaluate against the current end.

### Scoring

```
score =
  distance_weight * distance_to_pointer +
  amplitude_weight * amplitude_discontinuity +
  slope_weight * slope_discontinuity +
  energy_weight * local_energy
```

Candidate selection operates on decoded PCM but never alters the PCM.

### No zero crossing found

- Select the frame of minimum local amplitude.
- Mark the loop as `needs_manual_review`.
- Do not use crossfade.
- Visually indicate high discontinuity.

### Stereo handling

- Search for minima/crossings on a temporary mono signal for decision only.
- Store and play back original frames of all channels.
- Penalize candidates where any channel has high discontinuity.

## Phase 3: Precision Editing API

The current waveform contains peaks, not frame-level PCM samples. Sufficient for overview, not for choosing an exact zero crossing.

### Sample window command

Backend bounded command:

```
player_sample_window(track_id, center_frame, radius_frames, max_points)
```

Response:

```typescript
interface SampleWindow {
  start_frame: number;
  end_frame: number;
  sample_rate: number;
  channels: number;
  samples: number[];
}
```

Restrictions:

- Only reads the currently loaded buffer.
- Strict maximum on frames/points.
- Does not re-decode the file.
- Returns mono representation for visual editing; boundary calculation maintains multichannel backend validation.
- If track changes during query, return stale work error.

### Snap command

```
player_snap_loop_boundary(
  track_id,
  boundary: "start" | "end",
  requested_frame,
  other_boundary_frame
)
```

Frontend does not implement audio logic. It sends intent; Rust responds:

```typescript
interface SnappedBoundary {
  frame: number;
  ms: number;
  discontinuity: number;
  zero_crossing_found: boolean;
}
```

Keeps calculation consistent across manual editing, automatic creation, and future integrations.

## Phase 4: Waveform Viewport and Zoom

Replace fixed 30-second window with explicit state:

```typescript
interface WaveformViewport {
  startFrame: number;
  endFrame: number;
}
```

### Rules

- Initial view: full track.
- Fit: reset to full track.
- + and −: modify range by fixed factor (e.g. 2x).
- Wheel/trackpad: continuous zoom with pointer as anchor.
- Frame under cursor stays under cursor after zoom.
- Minimum: full track.
- Maximum: range sufficient to clearly see zero crossings (e.g. 20–100 ms depending on available width).
- Horizontal pan via drag on empty area or horizontal trackpad.

### Peak resolution

Peaks requested by visible resolution:

```
bucket_count ≈ viewport_width_px * device_pixel_ratio
```

To avoid hundreds of calculations:

- Debounce zoom (~100–150 ms).
- Cancellation/generation for stale results.
- Persistent cache by path + bucket_count.
- During active zoom, reuse last waveform; recalculate on interaction stop.
- At maximum zoom, use `player_sample_window`, not aggregated peaks.

## Phase 5: Start and End Handles

### Representation

- Vertical start line.
- Vertical end line.
- Shaded loop region.
- Visible handle at each edge.
- Labels: Start, End, duration and frame/ms.
- Union quality indicator: good, review.

### Interaction

1. `pointerdown` on handle.
2. Frontend captures pointer.
3. During `pointermove`, move a local preview.
4. Visual boundary snaps via backend response, throttled by `requestAnimationFrame`.
5. SQLite not persisted during drag.
6. `pointerup` confirms both frames.
7. Backend validates region, updates player, persists in single transaction.
8. `Escape` restores previous loop.
9. Double-click on waveform selects boundary of closest handle.
10. If both handles visible, they cannot cross.

### Audio restart prevention

- During drag, update visual overlay only.
- On drop, apply region to player.
- Add explicit "Preview loop" button or key to test several passes.
- Continuous preview during drag: implement later with debounce, not first iteration.

## Phase 6: Single-Loop Auto-Creator

Must not assume full audio is already circular.

### Pipeline

1. Start from decoded PCM and existing BPM/confidence.
2. Detect transients and energy per frame/block.
3. Estimate musical duration candidates: 1 beat, 2 beats, 1 bar, 2/4/8/16 bars.
4. Convert estimated duration to frames.
5. Find probable onset near transient or downbeat.
6. Calculate end with musical duration.
7. Apply zero crossing to start and end.
8. Calculate circular discontinuity.
9. Penalize: long unintentional silence, high discontinuity, duration far from BPM grid, end outside track, low energy incoherent with onset.
10. Choose exactly one winning candidate.
11. Store as `automatic` with score and confidence.
12. If below quality threshold, keep full track loop and mark low confidence; do not invent arbitrary loop.

### Scoring

```
score =
  bpm_alignment +
  transient_alignment +
  circular_similarity +
  zero_crossing_quality -
  boundary_discontinuity -
  silence_penalty
```

### Persistence

New SQLite columns:

| Column | Type | Values |
|--------|------|--------|
| `loop_origin` | TEXT | `"automatic"` \| `"manual"` |
| `loop_quality` | REAL | 0.0–1.0 |
| `loop_needs_review` | INTEGER | 0 or 1 |

Manual edit immediately sets origin to `manual`. No subsequent analysis overwrites it.

## Phase 7: MP3 and Problematic Material

Extracted MP3s may contain encoder delay or padding. Even at a zero crossing, audio may not close musically.

### Per-file investigation

- Compare Flash `sample_count` with decoded PCM frames.
- Preserve and apply `seek_samples` from `DefineSound`.
- Review `trimmed_leading`.
- Identify delay/padding if reliable LAME/Xing metadata exists.
- Do not remove samples based on unverified heuristics.
- Add real fixtures before claiming general compatibility.

If original material has a recorded gap or is non-circular, the editor must let the user locate the best real point but cannot guarantee a perfect loop without modifying audio.

## Phase 8: Tests and Criteria

### Rust tests

- Frame↔timeline conversion (original/stretched)
- Boundaries `[start, end)` with no lost or duplicated frames
- Zero crossing selector (mono and stereo)
- Minimum amplitude fallback
- Zero crossing does not cross the other boundary
- Correct remapping with pitch lock
- Auto-loop selects the single expected candidate on synthetic fixture
- Manual loop is not overwritten
- Stale waveform/sample window responses are discarded

### Frontend tests

- Zoom anchored to pointer
- Fit
- Drag does not persist before `pointerup`
- `Escape` cancels
- Handles do not cross
- Snapping response updates correct marker

### Manual criteria

- WAV circular loop: no gap or click after dozens of passes
- Real MP3 loop: result correctly classified as clean or material requiring adjustment
- Zoom to frame level: handles remain precise
- Speed change and pitch lock: loop/cues remain at expected musical position

### Central continuity test (no hardware)

Consume several cycles of `LoopRegion` and verify:

- Never returns `None`
- Frame sequence matches the expected interval
- Boundary exactly repeats `start_frame`

Test matrix:

- Synthetic WAV perfectly circular
- Synthetic WAV with deliberate discontinuity
- WAV with single-sample loop
- MP3 extracted from SWF
- ADPCM Flash converted to WAV
- Loop with pitch lock enabled
- Loop at 50%, 100%, and 200% speed

## Acceptance criteria

- [ ] Loop boundaries are frame-accurate with no invented samples
- [ ] Discontinuity measurement available for debugging
- [ ] Classification distinguishes continuous, click, gap, and non-circular material
- [ ] Central test passes: N cycles produce correct frame sequence with exact boundary repeat
- [ ] All test matrix cases pass
- [ ] `player_sample_window` returns bounded mono samples from loaded buffer
- [ ] `player_snap_loop_boundary` returns snapped frame with discontinuity score
- [ ] Viewport zoom anchored to cursor, fit resets to full track
- [ ] Handle drag does not persist until pointerup; Escape cancels
- [ ] Auto-loop selects exactly one candidate from synthetic fixture
- [ ] Manual edit sets origin to `manual`; no subsequent overwrite
- [ ] MP3 fixtures validated before claiming compatibility

## Implementation order

1. Fixtures, metrics, and deterministic continuity test
2. Internal frame model and original/stretched transformation
3. Backend zero crossing service
4. Frame persistence and manual/automatic origin
5. Viewport, zoom, and pan
6. Handles and drag confirmation
7. Loop preview
8. Auto-creator with single candidate
9. Validation on real loopers
