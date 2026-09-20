//! Hardware-free tests with hand-built PCM WAVs.

use super::*;
use crate::player::LoopBuffer;

fn wav(samples: &[i16], channels: u16, rate: u32) -> Vec<u8> {
    let n = samples.len();
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&((36 + n * 2) as u32).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&channels.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    v.extend_from_slice(&(channels * 2).to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&((n * 2) as u32).to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    v
}

fn approx(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-5
}

#[test]
fn mono_buckets_are_exact() {
    // 256-frame ramp, 64 buckets → bucket i holds frames 4i..4i+4,
    // peak (4i+3)/255 after normalization.
    let samples: Vec<i16> = (0..256).collect();
    let data = wav(&samples, 1, 8000);
    let buf = crate::player::decode_bytes(&data).unwrap();
    let w = from_buffer(&buf, 64);
    assert_eq!(w.peaks.len(), 64);
    for (i, p) in w.peaks.iter().enumerate() {
        assert!(approx(*p, (4 * i + 3) as f32 / 255.0), "bucket {i}: {p}");
    }
    assert_eq!(w.duration_ms, 32); // 256 frames @ 8 kHz
}

#[test]
fn stereo_mixes_down() {
    // L=8000, R=-8000 per frame → mix 0.
    let data = wav(&[8000, -8000, 8000, -8000], 2, 8000);
    let buf = crate::player::decode_bytes(&data).unwrap();
    let w = from_buffer(&buf, 64);
    assert!(w.peaks.iter().all(|&p| p == 0.0));
}

#[test]
fn silence_is_flat_not_error() {
    let data = wav(&[0; 16], 1, 8000);
    let w = compute(&data, 100).unwrap();
    assert_eq!(w.peaks.len(), 100);
    assert!(w.peaks.iter().all(|&p| p == 0.0));
}

#[test]
fn bucket_count_clamps() {
    assert_eq!(clamp_buckets(0), MIN_BUCKETS);
    assert_eq!(clamp_buckets(1_000_000), MAX_BUCKETS);
    assert_eq!(clamp_buckets(500), 500);
}

#[test]
fn garbage_errors() {
    assert!(compute(b"not audio", 128).is_err());
}

#[test]
fn empty_buffer_is_flat() {
    let empty = LoopBuffer {
        samples: vec![],
        channels: 1,
        rate: 44100,
    };
    let w = from_buffer(&empty, 128);
    assert_eq!(w.duration_ms, 0);
    assert!(w.peaks.iter().all(|&p| p == 0.0));
}

#[test]
fn persistent_cache_reuses_peaks_for_unchanged_audio() {
    let root = std::env::temp_dir().join(format!(
        "olooper-waveform-cache-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let source = root.join("loop.wav");
    let cache = root.join("cache");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(&source, b"source fingerprint").unwrap();
    let first_buffer = LoopBuffer {
        samples: vec![0, 20_000, 0, 10_000],
        channels: 1,
        rate: 8_000,
    };
    let first = cached_from_buffer(&cache, &source, 64, &first_buffer).unwrap();
    let changed_buffer = LoopBuffer {
        samples: vec![0; 4],
        channels: 1,
        rate: 8_000,
    };
    let cached = cached_from_buffer(&cache, &source, 64, &changed_buffer).unwrap();
    assert_eq!(cached.peaks, first.peaks);
    assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1);
    std::fs::remove_dir_all(root).ok();
}
