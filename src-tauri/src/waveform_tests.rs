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

/// Algorithm-v2 reference before cooperative chunking. Keep the arithmetic and
/// reduction order independent from the production checked/unchecked wrappers.
fn reference_peak_bits(buf: &LoopBuffer, buckets: usize) -> Vec<u32> {
    let buckets = clamp_buckets(buckets);
    let frames = buf.frames();
    let ch = buf.channels.max(1) as usize;
    let mut peaks = vec![0f32; buckets];
    if frames != 0 {
        for (i, bucket) in peaks.iter_mut().enumerate() {
            let start = i * frames / buckets;
            let end = ((i + 1) * frames / buckets).max(start + 1).min(frames);
            let mut max = 0f32;
            for frame in start..end {
                let mut mix = 0f32;
                for channel in 0..ch {
                    mix += buf.samples.get(frame * ch + channel).copied().unwrap_or(0) as f32
                        / 32768.0;
                }
                max = max.max((mix / ch as f32).abs());
            }
            *bucket = max;
        }
        let global = peaks.iter().copied().fold(0f32, f32::max);
        if global > 0.0 {
            for peak in &mut peaks {
                *peak /= global;
            }
        }
    }
    peaks.into_iter().map(f32::to_bits).collect()
}

#[test]
fn checked_waveforms_preserve_algorithm_v2_peak_bits_across_layouts_and_chunks() {
    for channels in [0u16, 1, 2, 8] {
        for frames in [0, 1, 17, 97, CHECK_INTERVAL_FRAMES + 19] {
            let samples = (0..frames * usize::from(channels.max(1)))
                .map(|index| (index.wrapping_mul(7919).wrapping_add(12345) as u16) as i16)
                .collect();
            let buf = LoopBuffer {
                samples,
                channels,
                rate: if frames == 17 { 0 } else { 44_100 },
            };
            for buckets in [0, 64, 127, MAX_BUCKETS, usize::MAX] {
                let checked = from_buffer_checked(&buf, buckets, || Ok::<(), ()>(())).unwrap();
                let unchecked = from_buffer(&buf, buckets);
                let expected = reference_peak_bits(&buf, buckets);
                assert_eq!(
                    checked
                        .peaks
                        .iter()
                        .map(|peak| peak.to_bits())
                        .collect::<Vec<_>>(),
                    expected
                );
                assert_eq!(
                    unchecked
                        .peaks
                        .iter()
                        .map(|peak| peak.to_bits())
                        .collect::<Vec<_>>(),
                    expected
                );
                assert_eq!(checked.buckets, clamp_buckets(buckets));
                assert_eq!(checked.duration_ms, buf.duration_ms());
            }
        }
    }
}

#[test]
fn checked_waveforms_can_stop_before_scanning_or_allocating_peaks() {
    let buf = LoopBuffer {
        samples: vec![1000; CHECK_INTERVAL_FRAMES * 4],
        channels: 1,
        rate: 44_100,
    };
    let mut checks = 0;
    let result = from_buffer_checked(&buf, MAX_BUCKETS, || {
        checks += 1;
        Err("obsolete")
    });
    assert_eq!(result.unwrap_err(), "obsolete");
    assert_eq!(checks, 1);
}

#[test]
fn checked_waveforms_stop_at_a_mid_scan_or_final_checkpoint() {
    for frames in [CHECK_INTERVAL_FRAMES * 4, 31] {
        let buf = LoopBuffer {
            samples: vec![1000; frames],
            channels: 1,
            rate: 44_100,
        };
        let mut checks = 0;
        let result = from_buffer_checked(&buf, MIN_BUCKETS, || {
            checks += 1;
            if checks == 2 {
                Err("obsolete")
            } else {
                Ok(())
            }
        });
        assert_eq!(result.unwrap_err(), "obsolete");
        assert_eq!(checks, 2);
    }
}

#[test]
fn waveform_checkpoint_cost_is_bounded_by_visited_frames_not_buckets() {
    for frames in [
        0,
        1,
        CHECK_INTERVAL_FRAMES,
        CHECK_INTERVAL_FRAMES + 1,
        CHECK_INTERVAL_FRAMES * 2 + 1,
    ] {
        let buf = LoopBuffer {
            samples: vec![1000; frames],
            channels: 1,
            rate: 44_100,
        };
        for buckets in [MIN_BUCKETS, MAX_BUCKETS] {
            let mut checks = 0;
            from_buffer_checked(&buf, buckets, || {
                checks += 1;
                Ok::<(), ()>(())
            })
            .unwrap();
            let expected = if frames == 0 {
                1
            } else {
                2 + (frames.max(buckets) - 1) / CHECK_INTERVAL_FRAMES
            };
            assert_eq!(checks, expected, "frames={frames}, buckets={buckets}");
        }
    }
}

#[test]
fn cancelled_empty_waveform_does_not_return_a_successful_flat_result() {
    let empty = LoopBuffer {
        samples: vec![],
        channels: 1,
        rate: 44_100,
    };
    assert_eq!(
        from_buffer_checked(&empty, MIN_BUCKETS, || Err("obsolete")).unwrap_err(),
        "obsolete"
    );
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

#[test]
fn cache_rejects_oversized_entries_and_invalid_peak_values() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.wav");
    std::fs::write(&source, b"fingerprint").unwrap();
    let target = cache_target(root.path(), &source, 64).unwrap();
    let file = std::fs::File::create(&target).unwrap();
    file.set_len(MAX_CACHE_ENTRY_BYTES + 1).unwrap();
    assert!(cache_lookup(root.path(), &source, 64).is_none());
    let invalid = WaveformData {
        peaks: vec![2.0; 64],
        duration_ms: 1000,
        buckets: 64,
    };
    std::fs::write(&target, serde_json::to_vec(&invalid).unwrap()).unwrap();
    assert!(cache_lookup(root.path(), &source, 64).is_none());
}

#[test]
fn persistent_cache_enforces_aggregate_bytes_and_entry_count() {
    let root = tempfile::tempdir().unwrap();
    let oversized = root.path().join("oversized.json");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(MAX_CACHE_BYTES + 1)
        .unwrap();
    prune_cache(root.path());
    assert!(!oversized.exists());
    for index in 0..=MAX_CACHE_FILES {
        std::fs::write(root.path().join(format!("{index}.json")), b"{}").unwrap();
    }
    prune_cache(root.path());
    assert!(std::fs::read_dir(root.path()).unwrap().count() <= MAX_CACHE_FILES);
}
