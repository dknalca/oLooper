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
fn loop_region_repeats_exact_boundary_frames() {
    let buf = mono(vec![-4, -2, 0, 3, 5, 2, 0, -3]);
    let mut src = LoopRegion::new(buf, 2, 2, 7, true, cursor());
    let got: Vec<i16> = src.by_ref().take(15).collect();
    assert_eq!(got, vec![0, 3, 5, 2, 0, 0, 3, 5, 2, 0, 0, 3, 5, 2, 0]);
}

#[test]
fn zero_crossing_snap_prefers_nearest_crossing() {
    let buf = LoopBuffer { samples: vec![-5, -2, 0, 3, 5, 2, -1, -4], channels: 1, rate: 1000 };
    assert_eq!(snap_zero_crossing(&buf, 3), 3);
    assert_eq!(snap_zero_crossing(&buf, 6), 6);
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

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

#[test]
fn waveform_cache_hit_needs_no_engine_lock() {
    let client = spawn();
    let root = std::env::temp_dir().join(format!("olooper-waveform-nolock-{}", nanos()));
    let source = root.join("loop.wav");
    let cache = root.join("cache");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(&source, pcm_wav(64)).unwrap();
    let path = source.to_string_lossy().to_string();
    let buf = Arc::new(decode_bytes(&pcm_wav(64)).unwrap());
    *client.loaded_buffer.write().unwrap() = Some((path.clone(), 1, buf));
    // First call computes peaks and stores them persistently.
    let first = client.waveform_peaks(&path, 64, &cache).unwrap();
    assert_eq!(first.peaks.len(), 64);
    // A cache hit must succeed even while the WRITE lock is held elsewhere:
    // it takes no engine lock, so waveform can never block track loading.
    let _held = client.loaded_buffer.write().unwrap();
    let second = client.waveform_peaks(&path, 64, &cache).unwrap();
    assert_eq!(second.peaks, first.peaks);
    drop(_held);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn waveform_snapshot_current_matches_path_and_generation() {
    let loaded: LoadedSnapshot = Some(("/a.wav".to_string(), 1, mono(vec![1, 2, 3])));
    assert!(waveform_snapshot_current(&loaded, "/a.wav", 1));
    assert!(!waveform_snapshot_current(&loaded, "/a.wav", 2)); // reloaded track
    assert!(!waveform_snapshot_current(&loaded, "/b.wav", 1)); // other track
    assert!(!waveform_snapshot_current(&None, "/a.wav", 1));
}

fn loaded_for_pitch() -> Loaded {
    Loaded {
        path: "/a.wav".to_string(),
        generation: 7,
        buf: mono(vec![0; 8]),
        original_buf: mono(vec![0; 8]),
        start_frame: 0,
        end_frame: 8,
        enabled: true,
        source: LoopSource::Manual,
        resume_frame: 0,
        cursor: cursor(),
        volume: 0.8,
        speed: 1.2,
        pitch_lock: true,
        pitch_pending: true,
        pitch_job: 3,
        pitch_requested_speed: 1.2,
        pitch_job_speed: 1.2,
        pitch_error: None,
        loop_origin: "manual".to_string(),
        loop_quality: 1.0,
    }
}

#[test]
fn pitch_completion_applies_only_when_nothing_moved() {
    let t = loaded_for_pitch();
    assert!(pitch_job_current(&t, 7, 3, 1.2));
    assert!(!pitch_job_current(&t, 8, 3, 1.2)); // track changed
    assert!(!pitch_job_current(&t, 7, 2, 1.2)); // older job
    assert!(!pitch_job_current(&t, 7, 3, 1.3)); // speed changed
    let mut unlocked = loaded_for_pitch();
    unlocked.pitch_lock = false;
    assert!(!pitch_job_current(&unlocked, 7, 3, 1.2)); // lock disabled
    let mut idle = loaded_for_pitch();
    idle.pitch_pending = false;
    assert!(!pitch_job_current(&idle, 7, 3, 1.2)); // nothing pending
}

#[test]
fn load_completion_applies_only_to_latest_request() {
    let pending = Some(PendingLoad {
        generation: 2,
        path: "/b.wav".to_string(),
    });
    assert!(load_ready_current(&pending, 2, "/b.wav"));
    assert!(!load_ready_current(&pending, 1, "/b.wav")); // superseded decode
    assert!(!load_ready_current(&pending, 2, "/a.wav")); // other path
    assert!(!load_ready_current(&None, 2, "/b.wav")); // nothing pending
}

#[test]
fn frame_remap_scales_across_buffers() {
    assert_eq!(remap_frame(50, 100, 200), 100);
    assert_eq!(remap_frame(0, 100, 200), 0);
    assert_eq!(remap_frame(7, 0, 200), 0);
}
