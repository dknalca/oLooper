//! Hardware-free tests: loop math, region validation, synthetic WAV decode.
//! Nothing here touches `OutputStream`; CI-safe.

use super::*;
use std::sync::atomic::Ordering;

fn mono(frames: Vec<i16>) -> Arc<LoopBuffer> {
    Arc::new(LoopBuffer {
        samples: frames,
        channels: 1,
        rate: 1000, // 1 frame == 1 ms for readable assertions
    })
}

fn cursor() -> Arc<AtomicUsize> {
    Arc::new(AtomicUsize::new(0))
}

#[test]
fn loop_region_wraps_without_gaps() {
    let buf = mono(vec![0, 1, 2, 3, 4, 5]);
    let c = cursor();
    let mut src = LoopRegion::new(buf, 2, 2, 5, true, c.clone());
    let got: Vec<i16> = src.by_ref().take(9).collect();
    assert_eq!(got, vec![2, 3, 4, 2, 3, 4, 2, 3, 4]);
    assert_eq!(c.load(Ordering::Relaxed), 4);
}

#[test]
fn one_shot_region_ends() {
    let buf = mono(vec![0, 1, 2, 3, 4]);
    let mut src = LoopRegion::new(buf, 0, 0, 3, false, cursor());
    let got: Vec<i16> = src.by_ref().collect();
    assert_eq!(got, vec![0, 1, 2]);
    assert_eq!(src.next(), None);
}

#[test]
fn from_frame_clamps_into_region() {
    let buf = mono(vec![0, 1, 2, 3]);
    let c = cursor();
    let mut src = LoopRegion::new(buf, 99, 1, 3, true, c.clone());
    assert_eq!(src.next(), Some(1));
    assert_eq!(c.load(Ordering::Relaxed), 1);
}

#[test]
fn ms_frame_conversions_roundtrip() {
    assert_eq!(ms_to_frames(1500, 44100), 66150);
    assert_eq!(frames_to_ms(66150, 44100), 1500);
    assert_eq!(ms_to_frames(0, 0), 0);
    assert_eq!(frames_to_ms(10, 0), 0);
}

#[test]
fn region_validation_rejects_bad_ranges() {
    assert!(check_region(0, 1000, 5000).is_ok());
    assert!(check_region(1000, 1000, 5000).is_err()); // start == end
    assert!(check_region(2000, 1000, 5000).is_err()); // start > end
    assert!(check_region(0, 6000, 5000).is_err()); // end past duration
}

/// Minimal PCM16 mono WAV built by hand: 8000 Hz, `n` samples of silence
/// with a marker ramp so decode order is verifiable.
fn pcm_wav(n: usize) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&((36 + n * 2) as u32).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // PCM
    v.extend_from_slice(&1u16.to_le_bytes()); // mono
    v.extend_from_slice(&8000u32.to_le_bytes());
    v.extend_from_slice(&16000u32.to_le_bytes()); // byte rate
    v.extend_from_slice(&2u16.to_le_bytes()); // block align
    v.extend_from_slice(&16u16.to_le_bytes()); // bits
    v.extend_from_slice(b"data");
    v.extend_from_slice(&((n * 2) as u32).to_le_bytes());
    for i in 0..n {
        v.extend_from_slice(&(i as i16).to_le_bytes());
    }
    v
}

#[test]
fn synthetic_wav_decodes_end_to_end() {
    let buf = decode_bytes(&pcm_wav(800)).unwrap();
    assert_eq!(buf.channels, 1);
    assert_eq!(buf.rate, 8000);
    assert_eq!(buf.frames(), 800);
    assert_eq!(buf.duration_ms(), 100);
    assert_eq!(&buf.samples[0..4], &[0, 1, 2, 3]);
}

#[test]
fn garbage_is_not_audio() {
    assert!(decode_bytes(b"definitely not audio").is_err());
    assert!(decode_bytes(&[]).is_err());
}

#[test]
fn engine_reports_empty_without_touching_hardware() {
    let client = spawn();
    let st = client.status().unwrap();
    assert!(!st.loaded && !st.playing);
    let st = client.set_volume(50.0).unwrap();
    assert_eq!(st.volume_pct, 50.0);
    assert!(client.set_volume(101.0).is_err());
    // No track loaded: error whether or not an audio device exists.
    assert!(client.play().is_err());
}
