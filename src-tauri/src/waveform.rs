//! Waveform peaks: decode → mono mixdown → per-bucket max-abs, normalized.
//!
//! Computed once per (path, bucket-count) and cached in frontend memory.
//! No per-frame decoding: rendering works purely from this aggregate.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

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

fn cache_key(path: &std::path::Path, buckets: usize) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve audio path: {e}"))?;
    let meta = canonical
        .metadata()
        .map_err(|e| format!("cannot inspect audio path: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    Ok(format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{}:{modified}:{}",
                canonical.display(),
                meta.len(),
                clamp_buckets(buckets)
            )
            .as_bytes()
        )
    ))
}

/// Read a derived waveform cache entry or calculate and atomically store it.
pub fn cached_from_buffer(
    cache_dir: &std::path::Path,
    path: &std::path::Path,
    buckets: usize,
    buffer: &crate::player::LoopBuffer,
) -> Result<WaveformData, String> {
    let buckets = clamp_buckets(buckets);
    let key = cache_key(path, buckets)?;
    let target = cache_dir.join(format!("{key}.json"));
    if let Ok(data) = std::fs::read(&target) {
        if let Ok(cached) = serde_json::from_slice::<WaveformData>(&data) {
            if cached.buckets == buckets && cached.peaks.len() == buckets {
                return Ok(cached);
            }
        }
    }
    let waveform = from_buffer(buffer, buckets);
    if std::fs::create_dir_all(cache_dir).is_ok() {
        if let Ok(data) = serde_json::to_vec(&waveform) {
            let tmp = target.with_extension("json.tmp");
            if std::fs::write(&tmp, data).is_ok() {
                if std::fs::rename(&tmp, &target).is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
            }
        }
    }
    Ok(waveform)
}

#[cfg(test)]
#[path = "waveform_tests.rs"]
mod tests;
