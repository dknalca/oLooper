//! Tempo estimation: energy-flux onset envelope + autocorrelation.
//!
//! An assistant, never an authority: returns a value + confidence, or
//! `None` when nothing periodic stands out. Manual corrections always win
//! (stored as `bpm_source='manual'`, never re-analyzed).

use serde::{Deserialize, Serialize};

/// Analysis window and search range.
const HOP: usize = 512;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Below this normalized autocorrelation peak there is no estimate.
const MIN_PEAK: f64 = 0.15;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BpmEstimate {
    pub bpm: f64,
    pub confidence: f64,
}

fn mixdown(buf: &crate::player::LoopBuffer) -> Vec<f32> {
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

/// Rectified energy-flux onset envelope, one value per `HOP` samples.
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

fn autocorr(env: &[f32], lag: usize) -> f64 {
    let mut num = 0f64;
    let mut den = 0f64;
    for (i, &v) in env.iter().enumerate() {
        den += f64::from(v) * f64::from(v);
        if i + lag < env.len() {
            num += f64::from(v) * f64::from(env[i + lag]);
        }
    }
    if den <= 0.0 {
        0.0
    } else {
        num / den
    }
}

pub fn estimate(buf: &crate::player::LoopBuffer) -> Option<BpmEstimate> {
    if buf.rate == 0 || buf.frames() < buf.rate as usize {
        return None; // need ~1 s minimum
    }
    let mono = mixdown(buf);
    let env = onset_envelope(&mono);
    if env.iter().all(|&v| v <= 0.0) {
        return None; // silence
    }
    let env_rate = buf.rate as f64 / HOP as f64;
    let lag_for = |bpm: f64| (60.0 * env_rate / bpm).round() as usize;
    let lo = lag_for(MAX_BPM).max(1);
    let hi = lag_for(MIN_BPM).min(env.len() - 1);
    if hi <= lo + 1 {
        return None;
    }
    let ac: Vec<f64> = (lo..=hi).map(|lag| autocorr(&env, lag)).collect();
    let (best, &peak) = ac
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    if peak < MIN_PEAK {
        return None;
    }
    // Parabolic interpolation for sub-frame lag accuracy.
    let lag = (lo + best) as f64;
    let refined = if best > 0 && best + 1 < ac.len() {
        let (y0, y1, y2) = (ac[best - 1], ac[best], ac[best + 1]);
        let denom = y0 - 2.0 * y1 + y2;
        if denom.abs() > f64::EPSILON {
            lag + 0.5 * (y0 - y2) / denom
        } else {
            lag
        }
    } else {
        lag
    };
    let bpm = (60.0 * env_rate / refined * 10.0).round() / 10.0;
    if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
        return None;
    }
    Some(BpmEstimate {
        bpm,
        confidence: peak.clamp(0.0, 1.0),
    })
}

#[cfg(test)]
#[path = "analysis_tests.rs"]
mod tests;
