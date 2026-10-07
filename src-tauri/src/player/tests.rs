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
    let mut frame = [1.0f32; 8];
    map_stereo_frame(
        &mut frame,
        2,
        10.0 / i16::MAX as f32,
        11.0 / i16::MAX as f32,
    );
    assert_eq!(
        frame,
        [
            0.0,
            0.0,
            10.0 / i16::MAX as f32,
            11.0 / i16::MAX as f32,
            0.0,
            0.0,
            0.0,
            0.0
        ]
    );
}

#[test]
fn routes_mono_source_to_both_channels_of_selected_pair() {
    let mut frame = [1.0f32; 6];
    map_stereo_frame(&mut frame, 2, 7.0 / i16::MAX as f32, 9.0 / i16::MAX as f32);
    assert_eq!(
        frame,
        [
            0.0,
            0.0,
            7.0 / i16::MAX as f32,
            9.0 / i16::MAX as f32,
            0.0,
            0.0
        ]
    );
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
fn only_system_default_selection_tracks_system_default_device_changes() {
    assert!(should_reopen_default_output(
        &OutputSelection::default(),
        "Speakers",
        "USB Headset",
    ));
    assert!(!should_reopen_default_output(
        &OutputSelection {
            device_name: Some("Speakers".to_string()),
            ..OutputSelection::default()
        },
        "Speakers",
        "USB Headset",
    ));
    assert!(!should_reopen_default_output(
        &OutputSelection::default(),
        "Speakers",
        "Speakers",
    ));
}

#[test]
fn reapplying_system_default_reopens_an_old_device_after_default_changed() {
    assert!(!output_selection_matches_device(
        &OutputSelection::default(),
        "Realtek Digital Output",
        Some("Plantronics Headphones"),
    ));
    assert!(output_selection_matches_device(
        &OutputSelection::default(),
        "Plantronics Headphones",
        Some("Plantronics Headphones"),
    ));
    assert!(output_selection_matches_device(
        &OutputSelection {
            device_name: Some("Realtek Digital Output".to_string()),
            ..OutputSelection::default()
        },
        "Realtek Digital Output",
        Some("Plantronics Headphones"),
    ));
}

#[test]
fn output_config_selection_respects_channels_rate_format_and_buffer() {
    let supported = vec![
        cpal::SupportedStreamConfigRange::new(
            2,
            cpal::SampleRate(44_100),
            cpal::SampleRate(96_000),
            cpal::SupportedBufferSize::Range { min: 64, max: 1024 },
            cpal::SampleFormat::F32,
        ),
        cpal::SupportedStreamConfigRange::new(
            14,
            cpal::SampleRate(48_000),
            cpal::SampleRate(48_000),
            cpal::SupportedBufferSize::Range {
                min: 128,
                max: 2048,
            },
            cpal::SampleFormat::I16,
        ),
    ];

    let selected = choose_output_config(
        &supported,
        4,
        None,
        44_100,
        Some(48_000),
        Some(256),
        cpal::SampleFormat::F32,
    )
    .unwrap();
    assert_eq!(selected.channels(), 14);
    assert_eq!(selected.sample_rate().0, 48_000);
    assert_eq!(selected.sample_format(), cpal::SampleFormat::I16);

    assert!(choose_output_config(
        &supported,
        4,
        None,
        44_100,
        Some(44_100),
        Some(256),
        cpal::SampleFormat::F32,
    )
    .is_err());
    assert!(choose_output_config(
        &supported,
        4,
        None,
        48_000,
        Some(48_000),
        Some(4096),
        cpal::SampleFormat::F32,
    )
    .is_err());
}

#[test]
fn rodio_resamples_stereo_before_cpals_multichannel_mapping() {
    // Exercise Sink -> source-rate conversion -> stereo mixer -> the exact
    // post-mixer frame mapper used by CPAL for many device layouts.
    for source_rate in [48_000, 44_100] {
        for output_channels in [2, 4, 6, 8, 14, 16, 32] {
            for first_channel in (0..output_channels).step_by(2) {
                for input_channels in [1, 2] {
                    let source_frames = source_rate / 10;
                    let samples = (0..source_frames)
                        .flat_map(|frame| {
                            let left = 1_000 + (frame % 100) as i16;
                            if input_channels == 1 {
                                vec![left]
                            } else {
                                vec![left, -2_000]
                            }
                        })
                        .collect();
                    let buffer = Arc::new(LoopBuffer {
                        samples,
                        channels: input_channels,
                        rate: source_rate,
                    });
                    let source =
                        LoopRegion::new(buffer, 0, 0, source_frames as usize, true, cursor());
                    let (sink, queue) = Sink::new_idle();
                    sink.set_volume(0.8);
                    sink.pause();
                    sink.append(source);
                    let (controller, mut stream) = rodio::dynamic_mixer::mixer::<f32>(2, 48_000);
                    controller.add(RoutedOutputQueue {
                        inner: queue,
                        channels: input_channels,
                        rate: source_rate,
                    });
                    sink.play();

                    let mut rendered = vec![0.0f32; output_channels as usize * 256];
                    render_routed_output(
                        &mut rendered,
                        output_channels,
                        first_channel,
                        &mut stream,
                        &OutputMeter::default(),
                    );
                    for (frame_index, frame) in
                        rendered.chunks_exact(output_channels as usize).enumerate()
                    {
                        for (channel, sample) in frame.iter().enumerate() {
                            if channel != first_channel as usize
                                && channel != first_channel as usize + 1
                            {
                                assert!(
                            sample.abs() < 1e-6,
                            "unexpected signal on output {} frame {} for input {} ch, output {} ch pair {}–{} at {} Hz: {sample}",
                            channel + 1,
                            frame_index,
                            input_channels,
                            output_channels,
                            first_channel + 1,
                            first_channel + 2,
                            source_rate
                        );
                            }
                        }
                    }
                    assert!(rendered
                        .iter()
                        .skip(first_channel as usize)
                        .step_by(output_channels as usize)
                        .any(|sample| *sample != 0.0));
                    assert!(rendered
                        .iter()
                        .skip(first_channel as usize + 1)
                        .step_by(output_channels as usize)
                        .any(|sample| *sample != 0.0));
                    assert!(rendered
                        .iter()
                        .skip(first_channel as usize + 1)
                        .step_by(output_channels as usize)
                        .any(|sample| *sample != 0.0));
                }
            }
        }
    }
}

#[test]
fn routed_output_meter_tracks_left_and_right_peak_after_volume() {
    let meter = OutputMeter::default();
    // These are peak samples after sink volume has already been applied.
    meter.publish(8_192, 4_096);
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
    sink.pause();
    sink.append(source);
    assert!(sink.is_paused());
}

#[test]
fn output_reconfiguration_resumes_a_playing_transport() {
    let (sink, _queue) = Sink::new_idle();
    let source = LoopRegion::new(mono(vec![1, 2]), 0, 0, 2, true, cursor());
    sink.pause();
    sink.append(source);
    sink.play();
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
fn pitch_speed_changes_the_live_sample_step_without_changing_source_rate() {
    let speed = Arc::new(AtomicU32::new(1.0f32.to_bits()));
    let mut source = LoopRegion::new(
        mono(vec![0, 100, 200, 300, 400, 500, 600, 700]),
        0,
        0,
        8,
        true,
        cursor(),
    )
    .with_speed_control(speed.clone());

    assert_eq!(source.next(), Some(0));
    assert_eq!(source.next(), Some(100));
    speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    assert_eq!(source.next(), Some(200));
    assert_eq!(source.next(), Some(400));
    speed.store(0.5f32.to_bits(), Ordering::Relaxed);
    assert_eq!(source.next(), Some(600));
    assert_eq!(source.next(), Some(650));
    assert_eq!(rodio::Source::sample_rate(&source), 1000);
}

#[test]
fn dynamic_output_mixer_preserves_the_live_pitch_speed_change() {
    fn ramp_after_mixer(speed_factor: f32) -> Vec<f32> {
        let (controller, mut mixer) = rodio::dynamic_mixer::mixer::<f32>(1, 1000);
        let speed = Arc::new(AtomicU32::new(speed_factor.to_bits()));
        let source = LoopRegion::new(
            mono(vec![0, 1000, 2000, 3000, 4000, 5000, 6000]),
            0,
            0,
            7,
            false,
            cursor(),
        )
        .with_speed_control(speed);
        controller.add(source.convert_samples::<f32>());
        mixer.by_ref().take(3).collect()
    }

    let normal = ramp_after_mixer(1.0);
    let faster = ramp_after_mixer(2.0);
    let normal_step = normal[1] - normal[0];
    let faster_step = faster[1] - faster[0];
    assert!((faster_step / normal_step - 2.0).abs() < 0.02);
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

#[test]
fn output_recovery_reopens_disconnected_and_changed_default_devices() {
    let default = OutputSelection::default();
    assert!(!output_reopen_needed(
        &default,
        "Studio monitors",
        Some("Studio monitors"),
        true,
    ));
    assert!(output_reopen_needed(
        &default,
        "Studio monitors",
        Some("USB headphones"),
        true,
    ));
    assert!(output_reopen_needed(
        &default,
        "",
        Some("USB headphones"),
        true,
    ));

    let explicit = OutputSelection {
        device_name: Some("Studio monitors".to_string()),
        ..OutputSelection::default()
    };
    assert!(!output_reopen_needed(
        &explicit,
        "Studio monitors",
        Some("USB headphones"),
        true,
    ));
    assert!(output_reopen_needed(
        &explicit,
        "Studio monitors",
        None,
        false,
    ));
}

#[test]
fn library_unload_clears_audio_snapshot_and_invalidates_pending_decode() {
    let loaded_buffer = Arc::new(std::sync::RwLock::new(Some((
        "old-library/track.wav".to_string(),
        2,
        mono(vec![1, 2, 3]),
    ))));
    let (tx, _rx) = std::sync::mpsc::channel();
    let mut engine = Engine::new(loaded_buffer.clone(), tx);
    engine.generation = 2;
    engine.pending_load = Some(PendingLoad {
        generation: 2,
        path: "old-library/pending.wav".to_string(),
        request: AudioLoadRequest::file(
            "old-library/pending.wav".to_string(),
            "old-library/pending.wav".to_string(),
        ),
        identity: None,
    });
    engine.decode_running = true;
    engine.last_load_error = Some("stale error".to_string());

    engine.cmd_unload().unwrap();

    assert_eq!(engine.generation, 3);
    assert!(engine.pending_load.is_none());
    assert!(engine.last_load_error.is_none());
    assert!(loaded_buffer.read().unwrap().is_none());
    assert!(!load_ready_current(
        &engine.pending_load,
        2,
        "old-library/pending.wav"
    ));
    // Keep the worker gate set until the old decode completion arrives; a new
    // request waits behind it instead of allowing unbounded parallel decodes.
    assert!(engine.decode_running);
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
        playback_speed: Arc::new(AtomicU32::new(1.2f32.to_bits())),
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
fn pitch_completion_discards_stale_state_and_restarts_for_new_speed() {
    let t = loaded_for_pitch();
    assert!(pitch_job_current(&t, 7, 3, 1.2));
    assert!(!pitch_job_current(&t, 8, 3, 1.2)); // track changed
    assert!(!pitch_job_current(&t, 7, 2, 1.2)); // older job
    assert!(!pitch_job_current(&t, 7, 3, 1.3)); // speed changed
    assert!(!pitch_job_needs_replacement(&t, 1.2));
    let mut newer_speed = loaded_for_pitch();
    newer_speed.speed = 1.3;
    newer_speed.pitch_requested_speed = 1.3;
    assert!(pitch_job_current(&newer_speed, 7, 3, 1.2));
    assert!(pitch_job_needs_replacement(&newer_speed, 1.2));
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
        request: AudioLoadRequest::file("/b.wav".to_string(), "/b.wav".to_string()),
        identity: None,
    });
    assert!(load_ready_current(&pending, 2, "/b.wav"));
    assert!(!load_ready_current(&pending, 1, "/b.wav")); // superseded decode
    assert!(!load_ready_current(&pending, 2, "/a.wav")); // other path
    assert!(!load_ready_current(&None, 2, "/b.wav")); // nothing pending
}

#[test]
fn decoded_cache_identity_detects_replaced_files() {
    let original = FileIdentity {
        size: 120,
        modified: Some(std::time::SystemTime::UNIX_EPOCH),
    };
    let replacement = FileIdentity {
        size: 120,
        modified: Some(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1)),
    };
    assert_ne!(original, replacement);
    assert_ne!(
        original,
        FileIdentity {
            size: 121,
            modified: original.modified,
        }
    );
    let entry = DecodedCacheEntry {
        path: "library/loop.wav".to_string(),
        identity: original.clone(),
        buffer: mono(vec![0, 1]),
    };
    assert!(decoded_cache_entry_matches(
        &entry,
        "library/loop.wav",
        &original
    ));
    assert!(!decoded_cache_entry_matches(
        &entry,
        "library/loop.wav",
        &replacement
    ));
    assert!(!decoded_cache_entry_matches(
        &entry,
        "library/renamed.wav",
        &original
    ));
}

#[test]
fn frame_remap_scales_across_buffers() {
    assert_eq!(remap_frame(50, 100, 200), 100);
    assert_eq!(remap_frame(0, 100, 200), 0);
    assert_eq!(remap_frame(7, 0, 200), 0);
}

#[test]
fn metronome_buffer_has_four_beats_and_an_accented_downbeat() {
    let buffer = metronome_buffer(48_000, 120.0).unwrap();
    assert_eq!(buffer.channels, 2);
    assert_eq!(buffer.rate, 48_000);
    assert_eq!(buffer.frames(), 96_000);

    let beat_frames = 24_000;
    let click_frames = 48_000 * 32 / 1000;
    let peak = |beat: usize| {
        buffer.samples[beat * beat_frames * 2..(beat * beat_frames + click_frames) * 2]
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap()
    };
    assert!(peak(0) > peak(1) * 3 / 2);
    assert!(peak(1) > 0);
    assert!(buffer.samples[click_frames * 2..beat_frames * 2]
        .iter()
        .all(|sample| *sample == 0));
}

#[test]
fn metronome_rejects_invalid_tempos() {
    assert!(metronome_buffer(48_000, 0.0).is_err());
    assert!(metronome_buffer(48_000, 301.0).is_err());
    assert!(metronome_buffer(0, 120.0).is_err());
}
