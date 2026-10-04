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
fn routes_stereo_source_to_selected_multichannel_pair() {
    let buffer = Arc::new(LoopBuffer {
        samples: vec![10, 11, 20, 21],
        channels: 2,
        rate: 44_100,
    });
    let source = LoopRegion::new(buffer, 0, 0, 2, false, cursor());
    let meter = Arc::new(OutputMeter::default());
    let routed = RoutedLoopRegion::new(source, 4, 2, meter.clone());
    assert_eq!(rodio::Source::channels(&routed), 4);
    assert_eq!(routed.collect::<Vec<_>>(), vec![0, 0, 10, 11, 0, 0, 20, 21]);
    let (left, right) = meter.take_percentages();
    assert!(left > 0.0 && right > 0.0);
}

#[test]
fn routes_mono_source_to_both_channels_of_selected_pair() {
    let buffer = Arc::new(LoopBuffer {
        samples: vec![7, 9],
        channels: 1,
        rate: 44_100,
    });
    let source = LoopRegion::new(buffer, 0, 0, 2, false, cursor());
    let routed = RoutedLoopRegion::new(source, 4, 2, Arc::new(OutputMeter::default()));
    assert_eq!(routed.collect::<Vec<_>>(), vec![0, 0, 7, 7, 0, 0, 9, 9]);
}

#[test]
fn stereo_pairs_do_not_straddle_two_hardware_outputs() {
    assert!(validate_output_pair(0, 8).is_ok());
    assert!(validate_output_pair(2, 8).is_ok());
    assert!(validate_output_pair(6, 8).is_ok());
    assert!(validate_output_pair(1, 8).is_err());
    assert!(validate_output_pair(4, 4).is_err());
}

#[test]
fn rodio_stream_keeps_all_unselected_djm_channels_silent_after_resampling() {
    // Exercise the same Sink -> queue -> Rodio mixer path that feeds CPAL,
    // including its 44.1 kHz -> 48 kHz conversion. The test tone alone cannot
    // detect leaks introduced later than RoutedLoopRegion.
    for first_channel in [0, 2, 4, 6] {
        let samples = (0..4_410)
            .flat_map(|frame| [1_000 + (frame % 100) as i16, -2_000])
            .collect();
        let buffer = Arc::new(LoopBuffer {
            samples,
            channels: 2,
            rate: 44_100,
        });
        let source = LoopRegion::new(buffer, 0, 0, 4_410, true, cursor());
        let (sink, queue) = Sink::new_idle();
        sink.set_volume(0.8);
        queue_routed_source(
            &sink,
            source,
            8,
            first_channel,
            Arc::new(OutputMeter::default()),
            true,
        );
        let (controller, mut stream) = rodio::dynamic_mixer::mixer::<f32>(8, 48_000);
        controller.add(RoutedOutputQueue {
            inner: queue,
            channels: 8,
            rate: 44_100,
        });

        let rendered: Vec<_> = stream.by_ref().take(8 * 1_000).collect();
        assert_eq!(rendered.len(), 8 * 1_000);
        for frame in rendered.chunks_exact(8) {
            for (channel, sample) in frame.iter().enumerate() {
                if channel != first_channel as usize && channel != first_channel as usize + 1 {
                    assert!(
                        sample.abs() < 1e-6,
                        "unexpected signal on output {} for pair {}–{}: {sample}",
                        channel + 1,
                        first_channel + 1,
                        first_channel + 2
                    );
                }
            }
        }
        assert!(rendered
            .iter()
            .skip(first_channel as usize)
            .step_by(8)
            .any(|sample| *sample != 0.0));
    }
}

#[test]
fn routed_output_meter_tracks_left_and_right_peak_after_volume() {
    let buffer = Arc::new(LoopBuffer {
        samples: vec![16_384, 8_192, 16_384, 8_192],
        channels: 2,
        rate: 48_000,
    });
    let source = LoopRegion::new(buffer, 0, 0, 2, false, cursor());
    let meter = Arc::new(OutputMeter::default());
    meter.set_gain(0.5);
    let _ = RoutedLoopRegion::new(source, 2, 0, meter.clone()).collect::<Vec<_>>();
    let (left, right) = meter.take_percentages();
    assert!((left - 25.0).abs() < 0.1);
    assert!((right - 12.5).abs() < 0.1);
}

#[test]
fn output_test_buffer_sends_left_then_right_tones() {
    let buffer = output_test_buffer();
    let frames: Vec<_> = buffer.samples.chunks_exact(2).collect();
    let left_end = OUTPUT_TEST_TONE_FRAMES;
    let right_start = OUTPUT_TEST_TONE_FRAMES + OUTPUT_TEST_GAP_FRAMES;
    let right_end = right_start + OUTPUT_TEST_TONE_FRAMES;

    assert!(frames[..left_end].iter().any(|frame| frame[0] != 0));
    assert!(frames[..left_end].iter().all(|frame| frame[1] == 0));
    assert!(frames[left_end..right_start]
        .iter()
        .all(|frame| *frame == [0, 0]));
    assert!(frames[right_start..right_end]
        .iter()
        .any(|frame| frame[1] != 0));
    assert!(frames[right_start..right_end]
        .iter()
        .all(|frame| frame[0] == 0));
}

#[test]
fn output_reconfiguration_keeps_a_paused_transport_paused() {
    let (sink, _queue) = Sink::new_idle();
    let source = LoopRegion::new(mono(vec![1, 2]), 0, 0, 2, true, cursor());
    queue_routed_source(&sink, source, 2, 0, Arc::new(OutputMeter::default()), false);
    assert!(sink.is_paused());
}

#[test]
fn output_reconfiguration_resumes_a_playing_transport() {
    let (sink, _queue) = Sink::new_idle();
    let source = LoopRegion::new(mono(vec![1, 2]), 0, 0, 2, true, cursor());
    queue_routed_source(&sink, source, 2, 0, Arc::new(OutputMeter::default()), true);
    assert!(!sink.is_paused());
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
    let buf = LoopBuffer {
        samples: vec![-5, -2, 0, 3, 5, 2, -1, -4],
        channels: 1,
        rate: 1000,
    };
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
fn decoding_stops_when_pcm_exceeds_the_practice_duration() {
    let frames = (MAX_DURATION_MS as usize + 1) * 8;
    let error = decode_bytes(&pcm_wav(frames)).unwrap_err();
    assert!(error.contains("15 min practice limit"), "{error}");
}

#[test]
fn trims_short_aac_edge_silence_from_playback_buffer() {
    let mut samples = vec![0i16; 40];
    samples.extend_from_slice(&[10; 5]);
    samples.extend_from_slice(&[1000; 75]);
    samples.extend_from_slice(&[5; 6]);
    samples.extend_from_slice(&[0; 30]);
    let buffer = LoopBuffer {
        samples,
        channels: 1,
        rate: 1000,
    };
    let trimmed = trim_aac_edge_silence(buffer);
    assert_eq!(trimmed.frames(), 75);
    assert_eq!(trimmed.samples[0], 1000);
    assert_eq!(trimmed.samples.last(), Some(&1000));
}

#[test]
fn leaves_long_or_silent_aac_prefixes_untouched() {
    let mut long_silence = vec![0i16; 180];
    long_silence.extend_from_slice(&[1000; 20]);
    let long = LoopBuffer {
        samples: long_silence,
        channels: 1,
        rate: 1000,
    };
    assert_eq!(trim_aac_edge_silence(long.clone()).frames(), long.frames());

    let silence = LoopBuffer {
        samples: vec![0; 100],
        channels: 1,
        rate: 1000,
    };
    assert_eq!(
        trim_aac_edge_silence(silence.clone()).frames(),
        silence.frames()
    );
}

#[test]
fn malformed_m4a_returns_error_without_panicking() {
    let bytes = [0, 0, 0, 8, b'f', b't', b'y', b'p', 0, 0, 0, 0];
    assert!(decode_bytes(&bytes).is_err());
    assert!(decode_job(bytes.to_vec()).is_err());
}

#[test]
#[ignore = "set OLOOPER_M4A_FIXTURE to a downloaded Tablist .m4a"]
fn tablist_m4a_fixture_decodes_through_player_load_path() {
    let path = std::env::var("OLOOPER_M4A_FIXTURE").expect("set OLOOPER_M4A_FIXTURE");
    let bytes = std::fs::read(path).unwrap();
    let buffer = decode_job(bytes).expect("player decode path should support AAC in M4A");
    assert!(buffer.frames() > 0);
    assert_eq!(buffer.channels, 2);
    assert_eq!(buffer.rate, 44_100);
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
