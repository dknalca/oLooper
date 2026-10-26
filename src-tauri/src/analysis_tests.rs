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

/// A four-beat phrase with a strong downbeat and quieter off-beats.
fn accented_click_track(bpm: f64, rate: u32) -> LoopBuffer {
    let period = (60.0 * rate as f64 / bpm).round() as usize;
    let n = rate as usize * 12;
    let mut samples = vec![0i16; n];
    let mut beat = 0;
    let mut i = 0;
    while i < n {
        samples[i] = match beat % 4 {
            0 => i16::MAX,
            2 => 22_000,
            _ => 10_000,
        };
        beat += 1;
        i += period;
    }
    buf_from_mono(samples, rate)
}

#[test]
fn click_120bpm_estimated() {
    let est = estimate(&click_track(120.0, 44100)).expect("no estimate");
    assert!((est.bpm - 120.0).abs() < 1.0, "got {}", est.bpm);
    assert!(
        est.confidence < 0.5,
        "unaccented clicks are tempo-ambiguous: {est:?}"
    );
}

#[test]
fn accented_four_beat_phrase_confidently_estimates_tempo() {
    let est = estimate(&accented_click_track(120.0, 44100)).expect("no estimate");
    assert!((est.bpm - 120.0).abs() < 1.0, "got {}", est.bpm);
    assert!(
        est.confidence >= 0.5,
        "distinct accents should resolve tempo: {est:?}"
    );
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

fn perfect_loop(bpm: f64, bars: usize, rate: u32, accented: bool) -> LoopBuffer {
    let frames = (f64::from(rate) * 240.0 * bars as f64 / bpm).round() as usize;
    let mut samples = vec![0; frames];
    for beat in 0..bars * 4 {
        let start = (beat as f64 * 60.0 * f64::from(rate) / bpm).round() as usize;
        let amplitude = if !accented || beat % 4 == 0 {
            30_000.0
        } else if beat % 4 == 2 {
            22_000.0
        } else {
            14_000.0
        };
        for offset in 0..(rate as usize / 50) {
            if let Some(sample) = samples.get_mut(start + offset) {
                *sample = (amplitude * (-(offset as f64) * 250.0 / f64::from(rate)).exp()) as i16;
            }
        }
    }
    buf_from_mono(samples, rate)
}

fn estimate_loop(buffer: &LoopBuffer) -> BpmEstimate {
    estimate_with_context(buffer, TempoContext::PerfectLoop4_4).expect("no loop estimate")
}

#[test]
fn exact_loop_durations_recover_fractional_tempi_at_multiple_rates_and_lengths() {
    for bpm in [90.0, 100.0, 117.3, 120.0, 128.0] {
        for rate in [8000, 22050, 44100, 48000] {
            for bars in [1, 2, 4, 8, 16] {
                let buffer = perfect_loop(bpm, bars, rate, true);
                let result = estimate_loop(&buffer);
                assert!(
                    (result.bpm - bpm).abs() <= 0.051,
                    "bpm={bpm} rate={rate} bars={bars}: {result:?}"
                );
                assert!((0.0..=1.0).contains(&result.confidence));
            }
        }
    }
}

#[test]
fn three_and_five_bar_phrases_can_override_the_power_of_two_prior() {
    for (bpm, bars) in [(90.0, 3), (100.0, 5), (128.0, 3)] {
        let result = estimate_loop(&perfect_loop(bpm, bars, 44100, false));
        assert!(
            (result.bpm - bpm).abs() <= 0.051,
            "{bpm} in {bars} bars: {result:?}"
        );
    }
}

#[test]
fn stereo_duration_and_opposite_channel_polarity_preserve_loop_tempo() {
    let mono = perfect_loop(117.3, 4, 44100, true);
    let stereo = LoopBuffer {
        samples: mono
            .samples
            .iter()
            .flat_map(|sample| [*sample, -*sample])
            .collect(),
        channels: 2,
        rate: mono.rate,
    };
    let result = estimate_loop(&stereo);
    assert_eq!(result.bpm, estimate_loop(&mono).bpm);
    assert_eq!(result.confidence, estimate_loop(&mono).confidence);
}

#[test]
fn plain_quarter_notes_keep_octave_ambiguity_visible() {
    let result = estimate_loop(&perfect_loop(100.0, 4, 44100, false));
    assert_eq!(result.bpm, 100.0);
    assert!(result.confidence < 0.5, "{result:?}");
}

#[test]
fn periodic_intro_does_not_make_a_long_nonperiodic_loop_confident() {
    let mut buffer = perfect_loop(120.0, 32, 8000, false);
    buffer.samples[8000 * 8..].fill(0);
    let result = estimate_loop(&buffer);
    assert!(result.confidence < 0.5, "{result:?}");
}

#[test]
fn loop_mode_rejects_invalid_silent_and_oversized_duration_inputs() {
    for buffer in [
        LoopBuffer {
            samples: vec![0; 16000],
            channels: 1,
            rate: 8000,
        },
        LoopBuffer {
            samples: vec![100; 8000],
            channels: 1,
            rate: 0,
        },
        LoopBuffer {
            samples: vec![100; 8000],
            channels: 0,
            rate: 8000,
        },
        LoopBuffer {
            samples: vec![100; 8001],
            channels: 2,
            rate: 8000,
        },
        LoopBuffer {
            samples: vec![100; 901],
            channels: 1,
            rate: 1,
        },
        LoopBuffer {
            samples: vec![100; 10],
            channels: 1,
            rate: 8000,
        },
    ] {
        assert!(estimate_with_context(&buffer, TempoContext::PerfectLoop4_4).is_none());
    }
}

#[test]
fn loop_noise_never_gets_high_confidence_from_duration_alone() {
    let mut x = 0x12345678u32;
    let samples = (0..8000 * 8)
        .map(|_| {
            x = x.wrapping_mul(1664525).wrapping_add(1013904223);
            (x >> 16) as i16 / 4
        })
        .collect();
    if let Some(result) =
        estimate_with_context(&buf_from_mono(samples, 8000), TempoContext::PerfectLoop4_4)
    {
        assert!(result.confidence < 0.5, "{result:?}");
    }
}

#[test]
fn sustained_loop_without_attacks_still_has_a_low_confidence_duration_suggestion() {
    // Constant-energy square tone, four bars / 9.6 seconds at 100 BPM.
    let samples = (0..76800)
        .map(|frame| if frame / 16 % 2 == 0 { 1000 } else { -1000 })
        .collect();
    let result = estimate_loop(&buf_from_mono(samples, 8000));
    assert_eq!(result.bpm, 100.0);
    assert!(result.confidence <= 0.2, "{result:?}");
}
