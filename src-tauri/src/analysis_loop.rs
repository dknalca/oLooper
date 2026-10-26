//! Musical duration supplies the tempo candidates; onset periodicity ranks them.
//! Scratch space and correlation work are bounded independently of track length.

use super::{BpmEstimate, DISPLAY_MAX_BPM, DISPLAY_MIN_BPM};
use crate::player::{LoopBuffer, MAX_DURATION_MS};
use std::collections::BTreeMap;

const MIN_BPM: f64 = 20.0;
const MAX_BPM: f64 = 300.0;
const ENVELOPE_HZ: u32 = 200;
const WINDOW_SECONDS: usize = 16;
// A small prior for ordinary 1/2/4/8/... bar phrases, not a confidence boost.
// An irregular phrase with clearly stronger rhythm must still win.
const REGULAR_PHRASE_PRIOR: f64 = 0.08;
const MIN_RHYTHM_SUPPORT: f64 = 0.15;
const CLEAR_FAMILY_MARGIN: f64 = 0.2;

#[derive(Clone, Copy)]
struct Candidate {
    bars: usize,
    bpm: f64,
    support: f64,
}

struct Family {
    odd_bars: usize,
    representative: Candidate,
    support: f64,
    octave_support: f64,
}

impl Family {
    fn rank(&self) -> f64 {
        self.support
            + if self.odd_bars == 1 {
                REGULAR_PHRASE_PRIOR
            } else {
                0.0
            }
    }
}

/// Each spectrum is a centered onset envelope of at most sixteen seconds.
/// Summing channel energies avoids phase cancellation in stereo material.
fn envelopes(buf: &LoopBuffer, hop: usize) -> Option<(Vec<Vec<f32>>, bool)> {
    let frames = buf.frames();
    let channels = usize::from(buf.channels);
    let window_frames = (buf.rate as usize * WINDOW_SECONDS).min(frames);
    let starts = if frames <= window_frames {
        vec![0]
    } else {
        vec![0, (frames - window_frames) / 2, frames - window_frames]
    };
    let mut result = Vec::new();
    let mut audible = false;
    for start in starts {
        crate::check_cancelled().ok()?;
        let mut envelope = Vec::with_capacity(window_frames.div_ceil(hop));
        let mut previous_energy = 0.0f32;
        for (index, chunk) in buf.samples[start * channels..(start + window_frames) * channels]
            .chunks(hop * channels)
            .enumerate()
        {
            if index % 128 == 0 {
                crate::check_cancelled().ok()?;
            }
            let energy = chunk
                .iter()
                .map(|sample| {
                    let value = f32::from(*sample) / 32768.0;
                    value * value
                })
                .sum::<f32>()
                / chunk.len() as f32;
            audible |= energy > 0.0;
            // Window boundaries are not onsets. In particular, constant energy
            // must not appear rhythmic just because analysis began here.
            envelope.push(if index == 0 {
                0.0
            } else {
                (energy - previous_energy).max(0.0)
            });
            previous_energy = energy;
        }
        let mean = envelope.iter().sum::<f32>() / envelope.len() as f32;
        for value in &mut envelope {
            *value -= mean;
        }
        result.push(envelope);
    }
    Some((result, audible))
}

fn correlations(windows: &[Vec<f32>], max_lag: usize) -> Option<Vec<f64>> {
    let mut scores = vec![0.0; max_lag + 1];
    for (lag, score) in scores.iter_mut().enumerate().skip(1) {
        if lag % 16 == 0 {
            crate::check_cancelled().ok()?;
        }
        let mut sum = 0.0;
        let mut minimum = 1.0f64;
        for window in windows {
            let support = super::autocorr(window, lag);
            sum += support;
            minimum = minimum.min(support);
        }
        // A periodic intro alone must not make an entire long loop certain.
        *score = (sum / windows.len() as f64 + minimum) / 2.0;
    }
    Some(scores)
}

fn support_at(scores: &[f64], lag: f64) -> f64 {
    // A pulse can land on either side of an envelope bin. Permit that one-bin
    // uncertainty, without searching a broad interval that merges nearby tempi.
    let lower = lag.floor() as usize;
    [lower, lower + 1]
        .into_iter()
        .filter_map(|index| {
            scores
                .get(index)
                .map(|score| score * (1.0 - 0.15 * (index as f64 - lag).abs()))
        })
        .fold(0.0, f64::max)
}

fn preferred(bpm: f64) -> bool {
    (DISPLAY_MIN_BPM..=DISPLAY_MAX_BPM).contains(&bpm)
}

fn choose_representative(candidates: &[Candidate]) -> Candidate {
    let has_preferred = candidates.iter().any(|candidate| preferred(candidate.bpm));
    *candidates
        .iter()
        .filter(|candidate| !has_preferred || preferred(candidate.bpm))
        .max_by(|left, right| {
            left.support
                .total_cmp(&right.support)
                .then_with(|| {
                    (right.bpm / 100.0)
                        .ln()
                        .abs()
                        .total_cmp(&(left.bpm / 100.0).ln().abs())
                })
                .then_with(|| right.bars.cmp(&left.bars))
        })
        .expect("a tempo family is nonempty")
}

pub(super) fn estimate(buf: &LoopBuffer) -> Option<BpmEstimate> {
    let frames = buf.frames();
    if buf.rate == 0
        || frames == 0
        || buf.channels == 0
        || !buf.samples.len().is_multiple_of(usize::from(buf.channels))
        || buf.samples.len() > crate::memory::MAX_PCM_BYTES / 2
    {
        return None;
    }
    let duration = frames as f64 / f64::from(buf.rate);
    if duration > MAX_DURATION_MS as f64 / 1000.0 {
        return None;
    }
    crate::check_cancelled().ok()?;
    let min_bars = ((MIN_BPM * duration / 240.0).ceil() as usize).max(1);
    let max_bars = (MAX_BPM * duration / 240.0).floor() as usize;
    if min_bars > max_bars {
        return None;
    }
    let _work = crate::memory::work_guard();
    let hop = (buf.rate / ENVELOPE_HZ).max(1) as usize;
    let envelope_rate = f64::from(buf.rate) / hop as f64;
    let (windows, audible) = envelopes(buf, hop)?;
    if !audible {
        return None;
    }
    let scores = correlations(
        &windows,
        (60.0 * envelope_rate / MIN_BPM).ceil() as usize + 1,
    )?;
    let mut candidates: BTreeMap<usize, Vec<Candidate>> = BTreeMap::new();
    for bars in min_bars..=max_bars {
        let bpm = 240.0 * bars as f64 / duration;
        if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
            continue;
        }
        let odd_bars = bars >> bars.trailing_zeros();
        candidates.entry(odd_bars).or_default().push(Candidate {
            bars,
            bpm,
            support: support_at(&scores, 60.0 * envelope_rate / bpm),
        });
    }
    let mut families: Vec<Family> = candidates
        .into_iter()
        .map(|(odd_bars, candidates)| {
            let representative = choose_representative(&candidates);
            // Only immediate half/double-time alternatives count as support. A
            // three-beat subharmonic at 30 BPM is not evidence for a 120 BPM loop.
            let octave_support = candidates
                .iter()
                .filter(|candidate| {
                    candidate.bars == representative.bars * 2
                        || candidate.bars * 2 == representative.bars
                })
                .map(|candidate| candidate.support)
                .fold(0.0, f64::max);
            Family {
                odd_bars,
                representative,
                support: representative.support.max(octave_support),
                octave_support,
            }
        })
        .collect();
    families.sort_by(|left, right| {
        right
            .rank()
            .total_cmp(&left.rank())
            .then_with(|| left.odd_bars.cmp(&right.odd_bars))
    });
    let best = families.first()?;
    let competing_support = families
        .iter()
        .skip(1)
        .map(|family| family.support)
        .fold(0.0, f64::max);
    let margin = ((best.support - competing_support) / CLEAR_FAMILY_MARGIN).clamp(0.0, 1.0);
    let mut confidence = 0.25 + 0.65 * best.support * margin;
    if best.support < MIN_RHYTHM_SUPPORT {
        confidence = confidence.min(0.2);
    }
    if best.representative.support < MIN_RHYTHM_SUPPORT
        // Quantized onset bins and the missing first boundary attack can lower
        // the two-beat peak even for identical quarter notes. A 25% tolerance
        // keeps such plain pulses honestly half/double-time ambiguous.
        || best.octave_support >= best.representative.support * 0.75
    {
        confidence = confidence.min(0.49);
    }
    Some(BpmEstimate {
        bpm: (best.representative.bpm * 10.0).round() / 10.0,
        confidence: confidence.clamp(0.0, 1.0),
    })
}
