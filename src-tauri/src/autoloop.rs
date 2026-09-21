//! Single-loop auto-creator: energy-flux onsets + BPM-aligned durations +
//! zero-crossing boundary snapping + circular discontinuity scoring.
//!
//! Must not assume full audio is circular. Returns exactly one winning
//! candidate or `None` when nothing meets the quality threshold.

use serde::{Deserialize, Serialize};

use crate::analysis;
use crate::player::LoopBuffer;

/// Minimum track length in frames to attempt auto-looping.
const MIN_FRAMES: usize = 4410; // ~100 ms at 44.1 kHz
/// Hop size in samples for onset detection (matches analysis module).
const HOP: usize = 512;
/// Minimum loop duration: 1 beat at 200 BPM = 150 ms.
const MIN_DURATION_FACTOR: f64 = 0.15;
/// Maximum loop duration: 16 bars at 60 BPM = 64 s.
const MAX_DURATION_FACTOR: f64 = 64.0;
/// Weight for BPM grid alignment in scoring.
const W_BPM_ALIGN: f64 = 0.30;
/// Weight for transient alignment in scoring.
const W_TRANSIENT: f64 = 0.25;
/// Weight for zero-crossing quality at boundaries.
const W_ZERO_CROSS: f64 = 0.20;
/// Weight for low local energy at boundary (penalty).
const W_SILENCE: f64 = 0.15;
/// Weight for circular discontinuity (penalty).
const W_DISCONTINUITY: f64 = 0.10;
/// Maximum number of onset candidates to evaluate per duration.
const MAX_ONSET_CANDIDATES: usize = 64;
/// Quality threshold: below this, no loop is proposed.
const QUALITY_THRESHOLD: f64 = 0.30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoLoopCandidate {
    pub start_frame: usize,
    pub end_frame: usize,
    pub quality: f64,
    pub discontinuity: f64,
    pub zero_crossing_start: bool,
    pub zero_crossing_end: bool,
    pub bpm_aligned: bool,
    pub onset_frame: usize,
    pub duration_frames: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoLoopResult {
    pub candidate: Option<AutoLoopCandidate>,
    pub bpm: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub total_frames: usize,
    pub sample_rate: u32,
    /// All candidates considered (sorted by quality, descending).
    pub all_candidates: Vec<AutoLoopCandidate>,
}

fn mixdown(buf: &LoopBuffer) -> Vec<f32> {
    let ch = buf.channels.max(1) as usize;
    let frames = buf.frames();
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut mix = 0f32;
        for c in 0..ch {
            mix += buf.samples.get(f * ch + c).copied().unwrap_or(0) as f32 / 32768.0;
        }
        out.push(mix / ch as f32);
    }
    out
}

/// Rectified energy-flux onset envelope, one value per HOP samples.
fn onset_envelope(mono: &[f32]) -> Vec<f32> {
    let mut env = Vec::new();
    let mut prev = 0f32;
    for frame in mono.chunks(HOP) {
        let e: f32 = frame.iter().map(|x| x * x).sum();
        env.push((e - prev).max(0.0));
        prev = e;
    }
    env
}

/// Find onset peaks in the envelope. Returns frame positions (in original
/// sample frames, not envelope indices).
fn detect_onsets(env: &[f32], total_frames: usize) -> Vec<usize> {
    if env.len() < 3 {
        return Vec::new();
    }
    // Simple peak-picking: local maximum above median.
    let median = {
        let mut sorted: Vec<f32> = env.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        sorted[sorted.len() / 2]
    };
    let threshold = median * 1.5;
    let mut onsets = Vec::new();
    for i in 1..env.len() - 1 {
        if env[i] > env[i - 1] && env[i] > env[i + 1] && env[i] > threshold {
            let frame = (i * HOP).min(total_frames.saturating_sub(1));
            onsets.push(frame);
        }
    }
    onsets
}

/// Snap to the nearest zero crossing within ±radius_frames.
/// Returns (snapped_frame, was_zero_crossing).
fn snap_zero_crossing_with_flag(buf: &LoopBuffer, requested: usize, radius: usize) -> (usize, bool) {
    let frames = buf.frames();
    if frames < 2 {
        return (requested.min(frames), false);
    }
    let lo = requested.saturating_sub(radius).min(frames - 1);
    let hi = requested.saturating_add(radius).min(frames - 1);
    let channels = buf.channels.max(1) as usize;
    let mono = |frame: usize| -> i32 {
        (0..channels)
            .map(|ch| {
                buf.samples
                    .get(frame * channels + ch)
                    .copied()
                    .unwrap_or(0) as i32
            })
            .sum::<i32>()
            / channels as i32
    };
    let mut best: Option<(usize, u32)> = None;
    for frame in lo..hi {
        let (a, b) = (mono(frame), mono(frame + 1));
        if (a <= 0 && b >= 0) || (a >= 0 && b <= 0) {
            let distance = (frame + 1).abs_diff(requested) as u32;
            if best.is_none_or(|current| distance < current.1) {
                best = Some((frame + 1, distance));
            }
        }
    }
    match best {
        Some((frame, _)) => (frame, true),
        None => {
            // Fallback: minimum local amplitude.
            let frame = (lo..=hi)
                .min_by_key(|f| mono(*f).unsigned_abs())
                .unwrap_or(requested.min(frames));
            (frame, false)
        }
    }
}

/// Compute circular discontinuity at a loop junction.
/// Returns a value in [0.0, 1.0] where 0 = seamless.
fn circular_discontinuity(buf: &LoopBuffer, start_frame: usize, end_frame: usize) -> f64 {
    let frames = buf.frames();
    if frames < 2 || start_frame >= frames || end_frame == 0 {
        return 1.0;
    }
    let channels = buf.channels.max(1) as usize;
    let last = end_frame.min(frames) - 1;
    let first = start_frame;
    // Mono mixdown for discontinuity measurement.
    let sample = |frame: usize, ch: usize| -> f64 {
        buf.samples
            .get(frame * channels + ch)
            .copied()
            .unwrap_or(0) as f64
            / 32768.0
    };
    let mut max_jump = 0.0f64;
    for ch in 0..channels {
        let jump = (sample(last, ch) - sample(first, ch)).abs();
        if jump > max_jump {
            max_jump = jump;
        }
    }
    max_jump.clamp(0.0, 1.0)
}

/// Compute local energy at a frame (RMS of ±radius frames, mono).
fn local_energy(buf: &LoopBuffer, frame: usize, radius: usize) -> f64 {
    let frames = buf.frames();
    let channels = buf.channels.max(1) as usize;
    let lo = frame.saturating_sub(radius);
    let hi = (frame + radius).min(frames);
    if lo >= hi {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for f in lo..hi {
        let mono: f64 = (0..channels)
            .map(|ch| {
                buf.samples
                    .get(f * channels + ch)
                    .copied()
                    .unwrap_or(0) as f64
                    / 32768.0
            })
            .sum::<f64>()
            / channels as f64;
        sum += mono * mono;
        count += 1;
    }
    if count == 0 {
        0.0
    } else {
        (sum / count as f64).sqrt()
    }
}

/// Score a candidate loop.
fn score_candidate(
    buf: &LoopBuffer,
    start_frame: usize,
    end_frame: usize,
    onset_frame: usize,
    _bpm: Option<f64>,
    beat_frames: Option<f64>,
) -> AutoLoopCandidate {
    let frames = buf.frames();
    let duration = end_frame.saturating_sub(start_frame);

    // BPM alignment: how close is the duration to a multiple of beat_frames?
    let bpm_aligned;
    let bpm_score = match beat_frames {
        Some(bf) if bf > 0.0 => {
            let beats = duration as f64 / bf;
            let nearest_beat = beats.round();
            let deviation = (beats - nearest_beat).abs();
            bpm_aligned = deviation < 0.1;
            1.0 - deviation.min(1.0)
        }
        _ => {
            bpm_aligned = false;
            0.5 // neutral when no BPM
        }
    };

    // Transient alignment: how close is start_frame to an onset?
    let onset_dist = start_frame.abs_diff(onset_frame) as f64;
    let max_dist = (HOP as f64 * 4.0).max(1.0);
    let transient_score = (1.0 - (onset_dist / max_dist)).max(0.0);

    // Zero-crossing quality at boundaries.
    let radius = (buf.rate as usize / 100).max(1); // ±10 ms
    let (snap_start, zc_start) = snap_zero_crossing_with_flag(buf, start_frame, radius);
    let (snap_end, zc_end) = snap_zero_crossing_with_flag(buf, end_frame.saturating_sub(1), radius);
    let zero_cross_score = match (zc_start, zc_end) {
        (true, true) => 1.0,
        (true, false) | (false, true) => 0.6,
        (false, false) => 0.2,
    };

    // Silence penalty: low energy at boundaries.
    let energy_radius = (buf.rate as usize / 20).max(1); // ±50 ms
    let energy_start = local_energy(buf, snap_start, energy_radius);
    let energy_end = local_energy(buf, snap_end.min(frames.saturating_sub(1)), energy_radius);
    let silence_score = 1.0 - ((1.0 - energy_start).min(1.0) + (1.0 - energy_end).min(1.0)) / 2.0;

    // Circular discontinuity (penalty).
    let discontinuity = circular_discontinuity(buf, snap_start, snap_end + 1);
    let discontinuity_score = 1.0 - discontinuity;

    let quality = W_BPM_ALIGN * bpm_score
        + W_TRANSIENT * transient_score
        + W_ZERO_CROSS * zero_cross_score
        + W_SILENCE * silence_score
        + W_DISCONTINUITY * discontinuity_score;

    AutoLoopCandidate {
        start_frame: snap_start,
        end_frame: snap_end + 1,
        quality: quality.clamp(0.0, 1.0),
        discontinuity,
        zero_crossing_start: zc_start,
        zero_crossing_end: zc_end,
        bpm_aligned,
        onset_frame,
        duration_frames: duration,
    }
}

/// Suggest a single loop candidate for the given buffer.
///
/// `bpm_override` allows the caller to supply a known BPM (e.g. from
/// the library). If `None`, BPM is analyzed from the audio.
pub fn suggest(buf: &LoopBuffer, bpm_override: Option<f64>) -> AutoLoopResult {
    let total_frames = buf.frames();
    let sample_rate = buf.rate;

    if total_frames < MIN_FRAMES {
        return AutoLoopResult {
            candidate: None,
            bpm: None,
            bpm_confidence: None,
            total_frames,
            sample_rate,
            all_candidates: Vec::new(),
        };
    }

    // Step 1: Determine BPM.
    let (bpm, bpm_confidence, beat_frames) = if let Some(b) = bpm_override {
        let bf = 60.0 * buf.rate as f64 / b;
        (Some(b), None, Some(bf))
    } else {
        match analysis::estimate(buf) {
            Some(est) => {
                let bf = 60.0 * buf.rate as f64 / est.bpm;
                (Some(est.bpm), Some(est.confidence), Some(bf))
            }
            None => (None, None, None),
        }
    };

    // Step 2: Detect onsets.
    let mono = mixdown(buf);
    let env = onset_envelope(&mono);
    let is_silent = env.iter().all(|&v| v <= 0.0);
    let onsets = if is_silent {
        Vec::new()
    } else {
        detect_onsets(&env, total_frames)
    };

    // Step 3: Generate musical duration candidates (in frames).
    let mut durations: Vec<(f64, bool)> = Vec::new(); // (frames, is_beat_aligned)
    if is_silent {
        // Silence: no meaningful loop can be found.
        return AutoLoopResult {
            candidate: None,
            bpm,
            bpm_confidence,
            total_frames,
            sample_rate,
            all_candidates: Vec::new(),
        };
    }
    if let Some(bf) = beat_frames {
        // 1 beat, 2 beats, 1 bar (4 beats), 2 bars, 4 bars, 8 bars, 16 bars.
        let multipliers = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0];
        for &m in &multipliers {
            let dur = bf * m;
            let dur_frames = dur as usize;
            if dur_frames >= (MIN_DURATION_FACTOR * buf.rate as f64) as usize
                && dur_frames <= (MAX_DURATION_FACTOR * buf.rate as f64) as usize
                && dur_frames < total_frames
            {
                durations.push((dur, m.fract() == 0.0 && m <= 4.0));
            }
        }
    } else {
        // Without BPM, try common durations: 0.5s, 1s, 2s, 4s, 8s, 16s, 32s.
        let rates = buf.rate as f64;
        for &sec in &[0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0] {
            let dur_frames = (sec * rates) as usize;
            if dur_frames >= MIN_FRAMES && dur_frames < total_frames {
                durations.push((dur_frames as f64, false));
            }
        }
    }

    // Step 4: Evaluate candidates.
    let mut candidates: Vec<AutoLoopCandidate> = Vec::new();

    if durations.is_empty() {
        // Fallback: try full track minus 10% on each end.
        let margin = total_frames / 10;
        let c = score_candidate(buf, margin, total_frames - margin, margin, bpm, beat_frames);
        candidates.push(c);
    } else {
        // If we have onsets, use them as start candidates.
        // Otherwise, sample evenly spaced starts.
        let starts: Vec<usize> = if !onsets.is_empty() {
            // Take the most energetic onsets, capped at MAX_ONSET_CANDIDATES.
            if onsets.len() <= MAX_ONSET_CANDIDATES {
                onsets
            } else {
                // Keep every Nth onset.
                let step = onsets.len() / MAX_ONSET_CANDIDATES;
                onsets.iter().step_by(step).copied().collect()
            }
        } else {
            // Sample starts every ~1 second.
            let step = buf.rate.max(1) as usize;
            (0..total_frames).step_by(step).collect()
        };

        for &start in &starts {
            for &(dur, _) in &durations {
                let end = start + dur as usize;
                if end > total_frames {
                    continue;
                }
                let c = score_candidate(buf, start, end, start, bpm, beat_frames);
                candidates.push(c);
            }
        }
    }

    // Step 5: Pick the best candidate.
    candidates.sort_by(|a, b| {
        b.quality
            .partial_cmp(&a.quality)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(20); // Keep top 20 for display.

    let winner = candidates.first().cloned().filter(|c| c.quality >= QUALITY_THRESHOLD);

    AutoLoopResult {
        candidate: winner,
        bpm,
        bpm_confidence,
        total_frames,
        sample_rate,
        all_candidates: candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_silence(rate: u32, channels: u16, frames: usize) -> LoopBuffer {
        LoopBuffer {
            samples: vec![0i16; frames * channels as usize],
            channels,
            rate,
        }
    }

    fn make_sine(rate: u32, channels: u16, freq: f64, frames: usize) -> LoopBuffer {
        let mut samples = Vec::with_capacity(frames * channels as usize);
        for f in 0..frames {
            let t = f as f64 / rate as f64;
            let val = (2.0 * std::f64::consts::PI * freq * t).sin() * 16000.0;
            let s = val as i16;
            for _ in 0..channels as usize {
                samples.push(s);
            }
        }
        LoopBuffer {
            samples,
            channels,
            rate,
        }
    }

    #[test]
    fn silence_returns_none() {
        let buf = make_silence(44100, 2, 44100 * 5);
        let result = suggest(&buf, Some(120.0));
        assert!(result.candidate.is_none());
        assert_eq!(result.bpm, Some(120.0));
    }

    #[test]
    fn too_short_returns_none() {
        let buf = make_silence(44100, 2, 1000);
        let result = suggest(&buf, None);
        assert!(result.candidate.is_none());
    }

    #[test]
    fn sine_loop_detected() {
        // A 2-second 440 Hz sine at 44100 Hz mono should get a decent score.
        let buf = make_sine(44100, 1, 440.0, 44100 * 2);
        let result = suggest(&buf, Some(120.0));
        // With a pure sine, there should be some candidate.
        assert!(!result.all_candidates.is_empty());
    }

    #[test]
    fn bpm_override_used() {
        let buf = make_silence(44100, 2, 44100 * 10);
        let result = suggest(&buf, Some(128.0));
        assert_eq!(result.bpm, Some(128.0));
        assert!(result.bpm_confidence.is_none());
    }

    #[test]
    fn zero_crossing_snap_works() {
        // Create a signal with a known zero crossing.
        let rate = 44100u32;
        let frames = 1000;
        let mut samples = Vec::with_capacity(frames);
        for f in 0..frames {
            let val = if f < 500 { 10000i16 } else { -10000i16 };
            samples.push(val);
        }
        let buf = LoopBuffer {
            samples,
            channels: 1,
            rate,
        };
        let (snapped, found) = snap_zero_crossing_with_flag(&buf, 499, 50);
        assert!(found);
        assert!((499..=501).contains(&snapped));
    }

    #[test]
    fn discontinuity_low_for_seamless_loop() {
        // A sine looped at a zero crossing should have low discontinuity.
        let rate = 44100u32;
        let freq = 440.0f64;
        let period_frames = (rate as f64 / freq) as usize; // ~100 frames
        let frames = period_frames * 10;
        let buf = make_sine(rate, 1, freq, frames);
        let disc = circular_discontinuity(&buf, 0, period_frames);
        // Sine at exactly one period: should be near 0.
        assert!(disc < 0.05, "discontinuity was {disc}");
    }

    #[test]
    fn scoring_penalizes_silence() {
        let buf = make_silence(44100, 1, 44100 * 5);
        // Can't score silence (returns no candidates), but test local_energy.
        let e = local_energy(&buf, 1000, 100);
        assert!(e < 0.001);
    }
}
