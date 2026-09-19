//! Estimator tests on synthetic signals. No hardware, no files.

use super::*;
use crate::player::LoopBuffer;

fn buf_from_mono(samples: Vec<i16>, rate: u32) -> LoopBuffer {
    LoopBuffer {
        samples,
        channels: 1,
        rate,
    }
}

/// Impulse train at `bpm`: one full-scale sample per beat, 8 s long.
fn click_track(bpm: f64, rate: u32) -> LoopBuffer {
    let period = (60.0 * rate as f64 / bpm).round() as usize;
    let n = rate as usize * 8;
    let mut s = vec![0i16; n];
    let mut i = 0;
    while i < n {
        s[i] = i16::MAX;
        i += period;
    }
    buf_from_mono(s, rate)
}

#[test]
fn click_120bpm_estimated() {
    let est = estimate(&click_track(120.0, 44100)).expect("no estimate");
    assert!((est.bpm - 120.0).abs() < 1.0, "got {}", est.bpm);
    assert!(est.confidence > 0.3);
}

#[test]
fn click_90bpm_44100_estimated() {
    let est = estimate(&click_track(90.0, 44100)).expect("no estimate");
    assert!((est.bpm - 90.0).abs() < 1.0, "got {}", est.bpm);
}

#[test]
fn detected_double_or_half_time_is_normalized_to_library_range() {
    assert_eq!(normalize_bpm(60.0), Some(120.0));
    assert_eq!(normalize_bpm(180.0), Some(90.0));
    assert_eq!(normalize_bpm(128.0), Some(128.0));
}

#[test]
fn silence_yields_none() {
    assert!(estimate(&buf_from_mono(vec![0; 44100 * 2], 44100)).is_none());
}

#[test]
fn too_short_yields_none() {
    assert!(estimate(&buf_from_mono(vec![1000; 100], 8000)).is_none());
}

#[test]
fn noise_yields_none_or_low_confidence() {
    // Deterministic pseudo-noise: nothing periodic.
    let mut x: u32 = 0x12345678;
    let s: Vec<i16> = (0..44100 * 3)
        .map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            (x >> 16) as i16 / 4
        })
        .collect();
    match estimate(&buf_from_mono(s, 44100)) {
        None => {}
        Some(e) => assert!(e.confidence < 0.5, "overconfident: {e:?}"),
    }
}
