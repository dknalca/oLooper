//! Waveform peaks: decode → mono mixdown → per-bucket max-abs, normalized.
//!
//! Computed once per (path, bucket-count) and cached in frontend memory.
//! No per-frame decoding: rendering works purely from this aggregate.

use serde::{Deserialize, Serialize};

/// Bounds for client-requested bucket counts (allocation safety).
pub const MIN_BUCKETS: usize = 64;
pub const MAX_BUCKETS: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaveformData {
    /// One 0.0–1.0 peak per bucket, in track order.
    pub peaks: Vec<f32>,
    pub duration_ms: u64,
    pub buckets: usize,
}

pub fn clamp_buckets(n: usize) -> usize {
    n.clamp(MIN_BUCKETS, MAX_BUCKETS)
}

/// Peak computation over already-decoded audio. Pure and hardware-free.
pub fn from_buffer(buf: &crate::player::LoopBuffer, buckets: usize) -> WaveformData {
    let buckets = clamp_buckets(buckets);
    let frames = buf.frames();
    let ch = buf.channels.max(1) as usize;
    let mut peaks = vec![0f32; buckets];
    if frames == 0 {
        return WaveformData {
            peaks,
            duration_ms: 0,
            buckets,
        };
    }
    for (i, bucket) in peaks.iter_mut().enumerate() {
        let start = i * frames / buckets;
        let end = ((i + 1) * frames / buckets).max(start + 1).min(frames);
        let mut max = 0f32;
        for f in start..end {
            let mut mix = 0f32;
            for c in 0..ch {
                mix += buf.samples.get(f * ch + c).copied().unwrap_or(0) as f32 / 32768.0;
            }
            max = max.max((mix / ch as f32).abs());
        }
        *bucket = max;
    }
    let global = peaks.iter().copied().fold(0f32, f32::max);
    if global > 0.0 {
        for p in &mut peaks {
            *p /= global;
        }
    }
    WaveformData {
        peaks,
        duration_ms: buf.duration_ms(),
        buckets,
    }
}

/// Decode bytes and compute peaks in one step.
pub fn compute(data: &[u8], buckets: usize) -> Result<WaveformData, String> {
    let buf = crate::player::decode_bytes(data)?;
    Ok(from_buffer(&buf, buckets))
}

#[cfg(test)]
#[path = "waveform_tests.rs"]
mod tests;
