//! Practice player: decode-on-load + gapless region looping.
//!
//! Timing lives here, never in the UI: the frontend only polls
//! [`PlayerStatus`]. Hardware (`OutputStream`) is created lazily so unit
//! tests run headless; all loop math is hardware-free.

use std::collections::{BTreeSet, VecDeque};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SupportedBufferSize};
use rodio::dynamic_mixer::{self, DynamicMixerController};
use rodio::source::EmptyCallback;
use rodio::{Decoder, Sink, Source as _};
use serde::{Deserialize, Serialize};

/// Tracks longer than this are rejected (memory + practice-loop scope).
pub const MAX_DURATION_MS: u64 = 15 * 60 * 1000;
/// Inspection/read cap shared with the import pipeline.
const MAX_INPUT_LEN: u64 = 512 * 1024 * 1024;
/// Keep recently decoded practice loops hot without retaining unbounded PCM.
const DECODE_CACHE_MAX_BYTES: usize = 128 * 1024 * 1024;
const DECODE_CACHE_MAX_TRACKS: usize = 6;

/// Decoded, interleaved track audio.
#[derive(Debug, Clone)]
pub struct LoopBuffer {
    pub samples: Vec<i16>,
    pub channels: u16,
    pub rate: u32,
}

impl LoopBuffer {
    pub fn frames(&self) -> usize {
        if self.channels == 0 {
            0
        } else {
            self.samples.len() / self.channels as usize
        }
    }

    pub fn duration_ms(&self) -> u64 {
        if self.rate == 0 {
            0
        } else {
            self.frames() as u64 * 1000 / self.rate as u64
        }
    }

    fn memory_bytes(&self) -> usize {
        self.samples.len() * std::mem::size_of::<i16>()
    }
}

/// How a loop was created.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LoopSource {
    Manual,
    Automatic { confidence: f32 },
}

/// Infinite (or one-shot) region source. The same buffer is never re-decoded
/// or reopened while looping: wrap-around is an index reset.
pub struct LoopRegion {
    buf: Arc<LoopBuffer>,
    /// Fractional frame position in `buf`. This is advanced in the source
    /// domain so output-mixer resampling cannot cancel the pitch change.
    position: f64,
    output_channel: usize,
    start_frame: usize,
    end_frame: usize,
    enabled: bool,
    /// Current frame, mirrored for UI polling.
    cursor: Arc<AtomicUsize>,
    speed_control: Arc<AtomicU32>,
}

impl LoopRegion {
    pub fn new(
        buf: Arc<LoopBuffer>,
        from_frame: usize,
        start_frame: usize,
        end_frame: usize,
        enabled: bool,
        cursor: Arc<AtomicUsize>,
    ) -> Self {
        let from = from_frame.clamp(start_frame.min(end_frame), end_frame.max(start_frame));
        let s = Self {
            buf,
            position: from as f64,
            output_channel: 0,
            start_frame,
            end_frame,
            enabled,
            cursor,
            speed_control: Arc::new(AtomicU32::new(1.0f32.to_bits())),
        };
        s.cursor.store(from, Ordering::Relaxed);
        s
    }

    fn with_speed_control(mut self, speed_control: Arc<AtomicU32>) -> Self {
        self.speed_control = speed_control;
        self
    }
}

impl Iterator for LoopRegion {
    type Item = i16;

    fn next(&mut self) -> Option<i16> {
        let ch = self.buf.channels.max(1) as usize;
        if self.end_frame <= self.start_frame {
            return None;
        }
        let mut frame = self.position.floor() as usize;
        if self.enabled {
            if frame >= self.end_frame {
                let length = (self.end_frame - self.start_frame) as f64;
                self.position = self.start_frame as f64
                    + (self.position - self.start_frame as f64).rem_euclid(length);
                frame = self.position.floor() as usize;
            }
        } else if frame >= self.end_frame {
            return None;
        }
        let next_frame = if frame + 1 < self.end_frame {
            frame + 1
        } else if self.enabled {
            self.start_frame
        } else {
            frame
        };
        let fraction = (self.position - frame as f64) as f32;
        let sample_index = frame * ch + self.output_channel;
        let next_index = next_frame * ch + self.output_channel;
        let first = *self.buf.samples.get(sample_index)? as f32;
        let second = *self.buf.samples.get(next_index)? as f32;
        let sample = (first + (second - first) * fraction).round() as i16;
        if self.output_channel == 0 {
            self.cursor.store(frame, Ordering::Relaxed);
        }
        self.output_channel += 1;
        if self.output_channel == ch {
            self.output_channel = 0;
            let speed = f32::from_bits(self.speed_control.load(Ordering::Relaxed));
            let speed = if (0.5..=2.0).contains(&speed) {
                speed as f64
            } else {
                1.0
            };
            self.position += speed;
        }
        Some(sample)
    }
}

impl rodio::Source for LoopRegion {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        self.buf.channels
    }

    fn sample_rate(&self) -> u32 {
        self.buf.rate
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

struct OutputMeter {
    left_peak: AtomicUsize,
    right_peak: AtomicUsize,
}

impl Default for OutputMeter {
    fn default() -> Self {
        Self {
            left_peak: AtomicUsize::new(0),
            right_peak: AtomicUsize::new(0),
        }
    }
}

impl OutputMeter {
    fn reset(&self) {
        self.left_peak.store(0, Ordering::Relaxed);
        self.right_peak.store(0, Ordering::Relaxed);
    }

    fn publish(&self, left: u16, right: u16) {
        fn update_peak(peak: &AtomicUsize, sample: u16) {
            let current = peak.load(Ordering::Relaxed);
            let decayed = (current as f32 * 0.995) as usize;
            peak.store(decayed.max(sample as usize), Ordering::Relaxed);
        }
        update_peak(&self.left_peak, left);
        update_peak(&self.right_peak, right);
    }

    fn take_percentages(&self) -> (f32, f32) {
        let left = self.left_peak.load(Ordering::Relaxed);
        let right = self.right_peak.load(Ordering::Relaxed);
        (
            (left.min(i16::MAX as usize) as f32 * 100.0) / i16::MAX as f32,
            (right.min(i16::MAX as usize) as f32 * 100.0) / i16::MAX as f32,
        )
    }
}

fn map_stereo_frame<T: cpal::Sample + FromSample<f32>>(
    frame: &mut [T],
    first_channel: u16,
    left: f32,
    right: f32,
) {
    frame.fill(T::from_sample(0.0));
    let left_channel = first_channel as usize;
    if left_channel + 1 < frame.len() {
        frame[left_channel] = T::from_sample(left);
        frame[left_channel + 1] = T::from_sample(right);
    }
}

fn render_routed_output<T: cpal::Sample + FromSample<f32>>(
    output: &mut [T],
    channels: u16,
    first_channel: u16,
    source: &mut rodio::dynamic_mixer::DynamicMixer<f32>,
    output_meter: &OutputMeter,
) {
    let mut left_peak = 0u16;
    let mut right_peak = 0u16;
    let channels = channels as usize;
    let mut frames = output.chunks_exact_mut(channels);
    for frame in &mut frames {
        let left = source.next().unwrap_or(0.0);
        let right = source.next().unwrap_or(0.0);
        map_stereo_frame(frame, first_channel, left, right);
        left_peak = left_peak.max((left.abs().min(1.0) * i16::MAX as f32) as u16);
        right_peak = right_peak.max((right.abs().min(1.0) * i16::MAX as f32) as u16);
    }
    frames.into_remainder().fill(T::from_sample(0.0));
    output_meter.publish(left_peak, right_peak);
}

/// Rodio's Sink queue starts with an empty *mono* source. If that changing
/// metadata reaches Rodio's output mixer, its initial channel conversion can
/// copy real samples onto unselected hardware outputs when a track begins.
/// All sources queued on this sink use the same routed channel count and rate,
/// so advertise those stable properties from the moment the queue is attached.
struct RoutedOutputQueue {
    inner: rodio::queue::SourcesQueueOutput<f32>,
    channels: u16,
    rate: u32,
}

impl Iterator for RoutedOutputQueue {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next()
    }
}

impl rodio::Source for RoutedOutputQueue {
    fn current_frame_len(&self) -> Option<usize> {
        self.inner.current_frame_len()
    }

    fn channels(&self) -> u16 {
        self.channels
    }

    fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }
}

fn routed_sink(
    mixer: &Arc<DynamicMixerController<f32>>,
    output_rate: u32,
    source: LoopRegion,
    volume: f32,
    speed: f32,
) -> Result<Sink, String> {
    let source_channels = source.channels();
    let source_rate = source.sample_rate();
    if source_rate == 0 || output_rate == 0 {
        return Err("source and output sample rates must be nonzero".to_string());
    }
    source
        .speed_control
        .store(speed.to_bits(), Ordering::Relaxed);
    let (sink, queue) = Sink::new_idle();
    sink.set_volume(volume);
    // Apply pitch-speed in LoopRegion while retaining its nominal sample rate.
    // Otherwise DynamicMixer's UniformSourceIterator would resample away the
    // rate change made by Rodio's Sink::set_speed.
    sink.set_speed(1.0);
    sink.pause();
    // Append before connecting to the stereo mixer so the queue has stable
    // source channel metadata rather than its initial mono silence source.
    sink.append(source);
    mixer.add(RoutedOutputQueue {
        inner: queue,
        channels: source_channels,
        rate: source_rate,
    });
    crate::audio_log::write(&format!(
        "playback_source channels={source_channels} sample_rate={source_rate} speed={speed:.3} sink_speed=1.000 output_mix_channels=2 output_mix_rate={output_rate}"
    ));
    Ok(sink)
}

const OUTPUT_TEST_RATE: u32 = 48_000;
const OUTPUT_TEST_TONE_FRAMES: usize = 14_400; // 300 ms
const OUTPUT_TEST_GAP_FRAMES: usize = 4_800; // 100 ms

fn output_test_buffer() -> LoopBuffer {
    let total_frames = OUTPUT_TEST_TONE_FRAMES * 2 + OUTPUT_TEST_GAP_FRAMES * 2;
    let mut samples = Vec::with_capacity(total_frames * 2);
    for frame in 0..total_frames {
        let (left, right) = if frame < OUTPUT_TEST_TONE_FRAMES {
            let phase = frame as f32 * 440.0 * std::f32::consts::TAU / OUTPUT_TEST_RATE as f32;
            ((phase.sin() * 0.22 * i16::MAX as f32) as i16, 0)
        } else if frame < OUTPUT_TEST_TONE_FRAMES + OUTPUT_TEST_GAP_FRAMES {
            (0, 0)
        } else if frame < OUTPUT_TEST_TONE_FRAMES * 2 + OUTPUT_TEST_GAP_FRAMES {
            let right_frame = frame - OUTPUT_TEST_TONE_FRAMES - OUTPUT_TEST_GAP_FRAMES;
            let phase =
                right_frame as f32 * 660.0 * std::f32::consts::TAU / OUTPUT_TEST_RATE as f32;
            (0, (phase.sin() * 0.22 * i16::MAX as f32) as i16)
        } else {
            (0, 0)
        };
        samples.extend_from_slice(&[left, right]);
    }
    LoopBuffer {
        samples,
        channels: 2,
        rate: OUTPUT_TEST_RATE,
    }
}

fn metronome_buffer(sample_rate: u32, bpm: f32) -> Result<LoopBuffer, String> {
    if sample_rate == 0 || !bpm.is_finite() || !(30.0..=300.0).contains(&bpm) {
        return Err("metronome BPM must be between 30 and 300".to_string());
    }
    let beat_frames = (f64::from(sample_rate) * 60.0 / f64::from(bpm)).round() as usize;
    let bar_frames = beat_frames
        .checked_mul(4)
        .ok_or_else(|| "metronome buffer is too large".to_string())?;
    let max_bar_frames = sample_rate as usize * 8;
    if beat_frames == 0 || bar_frames > max_bar_frames {
        return Err("metronome buffer is outside supported limits".to_string());
    }
    let mut samples = vec![0i16; bar_frames * 2];
    let click_frames = ((sample_rate as usize * 32) / 1000).max(1).min(beat_frames);
    for beat in 0..4 {
        let frequency = if beat == 0 { 1_760.0 } else { 1_180.0 };
        let amplitude = if beat == 0 { 0.68 } else { 0.44 };
        for frame in 0..click_frames {
            let time = frame as f32 / sample_rate as f32;
            let envelope = (-(frame as f32) / (sample_rate as f32 * 0.009)).exp();
            let value = (time * frequency * std::f32::consts::TAU).sin()
                * envelope
                * amplitude
                * i16::MAX as f32;
            let sample = value as i16;
            let index = (beat * beat_frames + frame) * 2;
            samples[index] = sample;
            samples[index + 1] = sample;
        }
    }
    Ok(LoopBuffer {
        samples,
        channels: 2,
        rate: sample_rate,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioOutputDevice {
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub sample_rates: Vec<u32>,
    pub buffer_size_min: Option<u32>,
    pub buffer_size_max: Option<u32>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OutputSelection {
    /// None means follow the operating system's current default output.
    pub device_name: Option<String>,
    /// Zero-based first channel of the stereo pair.
    pub first_channel: u16,
    /// None uses the output device's preferred sample rate.
    pub sample_rate: Option<u32>,
    /// None asks the output device to choose its default buffer size.
    pub buffer_frames: Option<u32>,
}

fn validate_output_pair(first_channel: u16, channels: u16) -> Result<(), String> {
    if first_channel % 2 != 0 {
        return Err("stereo output must start on channel 1, 3, 5, etc.".to_string());
    }
    if first_channel.saturating_add(2) > channels {
        return Err(format!(
            "selected output pair requires {} channels, but the device exposes {channels}",
            first_channel.saturating_add(2)
        ));
    }
    Ok(())
}

pub fn list_output_devices() -> Result<Vec<AudioOutputDevice>, String> {
    crate::audio_log::write("device_enumeration_start");
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    crate::audio_log::write(&format!("system_default_device name={default_name:?}"));
    let devices = host.output_devices().map_err(|error| {
        let message = format!("device_enumeration_failed error={error}");
        crate::audio_log::write(&message);
        message
    })?;
    let mut outputs = Vec::new();
    for device in devices {
        let name = match device.name() {
            Ok(name) => name,
            Err(error) => {
                crate::audio_log::write(&format!("device_skipped name_error={error}"));
                continue;
            }
        };
        let configs = device
            .supported_output_configs()
            .map_err(|error| {
                let message = format!("device_capabilities_failed name={name:?} error={error}");
                crate::audio_log::write(&message);
                format!("cannot list output formats for {name}: {error}")
            })?
            .collect::<Vec<_>>();
        let channels = configs
            .iter()
            .map(|config| config.channels())
            .max()
            .unwrap_or(0);
        let mut sample_rates = BTreeSet::new();
        let mut buffer_min = None::<u32>;
        let mut buffer_max = None::<u32>;
        for config in configs
            .iter()
            .filter(|config| config.channels() == channels)
        {
            let min_rate = config.min_sample_rate().0;
            let max_rate = config.max_sample_rate().0;
            for rate in [
                min_rate, max_rate, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
            ] {
                if (min_rate..=max_rate).contains(&rate) {
                    sample_rates.insert(rate);
                }
            }
            if let SupportedBufferSize::Range { min, max } = config.buffer_size() {
                buffer_min = Some(buffer_min.map_or(*min, |old| old.min(*min)));
                buffer_max = Some(buffer_max.map_or(*max, |old| old.max(*max)));
            }
        }
        for config in &configs {
            crate::audio_log::write(&format!(
                "device_capability name={name:?} default={} channels={} sample_rate_min={} sample_rate_max={} sample_format={:?} buffer_size={:?}",
                default_name.as_deref() == Some(name.as_str()),
                config.channels(),
                config.min_sample_rate().0,
                config.max_sample_rate().0,
                config.sample_format(),
                config.buffer_size(),
            ));
        }
        outputs.push(AudioOutputDevice {
            id: name.clone(),
            is_default: default_name.as_deref() == Some(name.as_str()),
            name,
            channels,
            sample_rates: sample_rates.into_iter().collect(),
            buffer_size_min: buffer_min,
            buffer_size_max: buffer_max,
        });
    }
    outputs.sort_by(|left, right| left.name.cmp(&right.name));
    crate::audio_log::write(&format!(
        "device_enumeration_complete count={}",
        outputs.len()
    ));
    Ok(outputs)
}

struct OutputRuntime {
    stream: cpal::Stream,
    mixer: Arc<DynamicMixerController<f32>>,
    channels: u16,
    sample_rate: u32,
    device_name: String,
}

fn sample_format_rank(format: SampleFormat) -> u8 {
    match format {
        SampleFormat::F32 => 0,
        SampleFormat::F64 => 1,
        SampleFormat::I16 => 2,
        SampleFormat::I32 => 3,
        SampleFormat::U16 => 4,
        SampleFormat::U32 => 5,
        _ => 6,
    }
}

fn choose_output_config(
    configs: &[cpal::SupportedStreamConfigRange],
    required_channels: u16,
    preferred_channels: Option<u16>,
    preferred_sample_rate: u32,
    requested_sample_rate: Option<u32>,
    requested_buffer_frames: Option<u32>,
    preferred_sample_format: SampleFormat,
) -> Result<cpal::SupportedStreamConfig, String> {
    let mut candidates = Vec::new();
    for range in configs {
        if range.channels() < required_channels
            || preferred_channels.is_some_and(|channels| range.channels() != channels)
        {
            continue;
        }
        let sample_rate = if let Some(rate) = requested_sample_rate {
            rate
        } else {
            preferred_sample_rate.clamp(range.min_sample_rate().0, range.max_sample_rate().0)
        };
        let Some(config) = range
            .clone()
            .try_with_sample_rate(cpal::SampleRate(sample_rate))
        else {
            continue;
        };
        if let Some(frames) = requested_buffer_frames {
            match config.buffer_size() {
                SupportedBufferSize::Range { min, max } if (*min..=*max).contains(&frames) => {}
                SupportedBufferSize::Unknown => continue,
                SupportedBufferSize::Range { .. } => continue,
            }
        }
        let rate_distance = sample_rate.abs_diff(preferred_sample_rate);
        let format_penalty = u8::from(config.sample_format() != preferred_sample_format);
        candidates.push((config, rate_distance, format_penalty));
    }
    candidates.sort_by_key(|(config, rate_distance, format_penalty)| {
        (
            std::cmp::Reverse(config.channels()),
            *rate_distance,
            *format_penalty,
            sample_format_rank(config.sample_format()),
        )
    });
    candidates
        .into_iter()
        .next()
        .map(|(config, _, _)| config)
        .ok_or_else(|| {
            if let Some(rate) = requested_sample_rate {
                format!(
                    "device has no output configuration for {required_channels} channels at {rate} Hz with the requested buffer"
                )
            } else {
                format!(
                    "device has no compatible output configuration for {required_channels} channels"
                )
            }
        })
}

#[derive(Clone)]
struct OutputErrorReporter {
    tx: std::sync::mpsc::Sender<EngineCmd>,
    generation: u64,
    device_name: String,
    reported: Arc<AtomicBool>,
}

impl OutputErrorReporter {
    fn report(&self, error: cpal::StreamError) {
        if self.reported.swap(true, Ordering::Relaxed) {
            return;
        }
        let error = error.to_string();
        crate::audio_log::write(&format!(
            "audio_stream_error device={:?} error={error}",
            self.device_name
        ));
        let _ = self.tx.send(EngineCmd::OutputFailed {
            generation: self.generation,
            device_name: self.device_name.clone(),
            error,
        });
    }
}

fn build_typed_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut source: rodio::dynamic_mixer::DynamicMixer<f32>,
    output_channels: u16,
    first_channel: u16,
    output_meter: Arc<OutputMeter>,
    error_reporter: OutputErrorReporter,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + FromSample<f32>,
{
    device
        .build_output_stream::<T, _, _>(
            config,
            move |output, _| {
                render_routed_output(
                    output,
                    output_channels,
                    first_channel,
                    &mut source,
                    &output_meter,
                );
            },
            move |error| error_reporter.report(error),
            None,
        )
        .map_err(|error| format!("cannot open requested audio format: {error}"))
}

fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: SampleFormat,
    source: rodio::dynamic_mixer::DynamicMixer<f32>,
    output_channels: u16,
    first_channel: u16,
    output_meter: Arc<OutputMeter>,
    error_reporter: OutputErrorReporter,
) -> Result<cpal::Stream, String> {
    match format {
        SampleFormat::F32 => build_typed_output_stream::<f32>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::F64 => build_typed_output_stream::<f64>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::I8 => build_typed_output_stream::<i8>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::I16 => build_typed_output_stream::<i16>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::I32 => build_typed_output_stream::<i32>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::I64 => build_typed_output_stream::<i64>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::U8 => build_typed_output_stream::<u8>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::U16 => build_typed_output_stream::<u16>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::U32 => build_typed_output_stream::<u32>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter.clone(),
        ),
        SampleFormat::U64 => build_typed_output_stream::<u64>(
            device,
            config,
            source,
            output_channels,
            first_channel,
            output_meter,
            error_reporter,
        ),
        format => Err(format!("unsupported audio sample format: {format:?}")),
    }
}

struct SelectedOutputConfig {
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
}

fn select_output_config(selection: &OutputSelection) -> Result<SelectedOutputConfig, String> {
    crate::audio_log::write(&format!(
        "output_selection_requested device={:?} first_channel_index={} sample_rate_request={:?} buffer_frames_request={:?}",
        selection.device_name,
        selection.first_channel,
        selection.sample_rate,
        selection.buffer_frames,
    ));
    if selection.first_channel % 2 != 0 {
        let error = "stereo output must start on channel 1, 3, 5, etc.".to_string();
        crate::audio_log::write(&format!("output_selection_rejected reason={error}"));
        return Err(error);
    }
    let host = cpal::default_host();
    let device_result: Result<cpal::Device, String> = if let Some(name) = &selection.device_name {
        host.output_devices()
            .map_err(|error| {
                let message = format!("cannot enumerate output devices: {error}");
                crate::audio_log::write(&format!("output_device_enumeration_failed error={error}"));
                message
            })?
            .find(|device| device.name().is_ok_and(|device_name| device_name == *name))
            .ok_or_else(|| format!("audio output device is unavailable: {name}"))
    } else {
        host.default_output_device()
            .ok_or_else(|| "no default audio output device".to_string())
    };
    let device = device_result.map_err(|error| {
        crate::audio_log::write(&format!("output_device_selection_failed error={error}"));
        error
    })?;
    let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());

    let required_channels = selection.first_channel.saturating_add(2);
    let supported = device
        .supported_output_configs()
        .map_err(|error| {
            let message = format!("cannot query supported output configurations: {error}");
            crate::audio_log::write(&format!(
                "output_capabilities_failed device={device_name:?} error={error}"
            ));
            message
        })?
        .collect::<Vec<_>>();
    for candidate in &supported {
        crate::audio_log::write(&format!(
            "output_capability device={device_name:?} channels={} sample_rate_min={} sample_rate_max={} sample_format={:?} buffer_size={:?}",
            candidate.channels(),
            candidate.min_sample_rate().0,
            candidate.max_sample_rate().0,
            candidate.sample_format(),
            candidate.buffer_size(),
        ));
    }
    let max_channels = supported
        .iter()
        .map(|config| config.channels())
        .max()
        .unwrap_or(0);
    // An explicit multichannel interface must use its full stream even for
    // 1–2. Its default *stereo* configuration may represent a different
    // hardware destination (for example the DJ mixer master bus).
    let default = device.default_output_config().map_err(|error| {
        let message = format!("cannot query default output configuration: {error}");
        crate::audio_log::write(&format!(
            "default_output_config_failed device={device_name:?} error={error}"
        ));
        message
    })?;
    crate::audio_log::write(&format!(
        "default_output_config device={device_name:?} channels={} sample_rate={} sample_format={:?} buffer_size={:?}",
        default.channels(),
        default.sample_rate().0,
        default.sample_format(),
        default.buffer_size(),
    ));
    let use_default_channels =
        selection.first_channel == 0 && (selection.device_name.is_none() || max_channels <= 2);
    let preferred_channels = use_default_channels.then_some(default.channels());
    let config = choose_output_config(
        &supported,
        required_channels,
        preferred_channels,
        default.sample_rate().0,
        selection.sample_rate,
        selection.buffer_frames,
        default.sample_format(),
    )
    .map_err(|error| {
        crate::audio_log::write(&format!(
            "output_config_selection_failed device={device_name:?} error={error}"
        ));
        error
    })?;
    validate_output_pair(selection.first_channel, config.channels()).map_err(|error| {
        crate::audio_log::write(&format!(
            "output_channel_pair_rejected device={device_name:?} channels={} first_channel_index={} error={error}",
            config.channels(),
            selection.first_channel,
        ));
        error
    })?;
    crate::audio_log::write(&format!(
        "output_config_selected device={device_name:?} channels={} sample_rate={} sample_format={:?} buffer_size={:?} route_left_output={} route_right_output={}",
        config.channels(),
        config.sample_rate().0,
        config.sample_format(),
        config.buffer_size(),
        selection.first_channel + 1,
        selection.first_channel + 2,
    ));

    Ok(SelectedOutputConfig { device, config })
}

fn open_output(
    selection: &OutputSelection,
    output_meter: Arc<OutputMeter>,
    tx: std::sync::mpsc::Sender<EngineCmd>,
    generation: u64,
) -> Result<OutputRuntime, String> {
    let SelectedOutputConfig { device, config } = select_output_config(selection)?;
    let channels = config.channels();
    let sample_rate = config.sample_rate().0;
    let sample_format = config.sample_format();
    let mut stream_config = config.config();
    if let Some(frames) = selection.buffer_frames {
        stream_config.buffer_size = cpal::BufferSize::Fixed(frames);
    }
    let (mixer, source) = dynamic_mixer::mixer::<f32>(2, sample_rate);
    let name = device
        .name()
        .unwrap_or_else(|_| "unknown output".to_string());
    crate::audio_log::write(&format!(
        "output_stream_open_requested device={name:?} channels={channels} sample_rate={sample_rate} sample_format={sample_format:?} buffer_size={:?}",
        stream_config.buffer_size,
    ));
    let stream = build_output_stream(
        &device,
        &stream_config,
        sample_format,
        source,
        channels,
        selection.first_channel,
        output_meter,
        OutputErrorReporter {
            tx,
            generation,
            device_name: name.clone(),
            reported: Arc::new(AtomicBool::new(false)),
        },
    )
    .map_err(|error| {
        crate::audio_log::write(&format!(
            "output_stream_open_failed device={name:?} error={error}"
        ));
        error
    })?;
    stream.play().map_err(|error| {
        crate::audio_log::write(&format!(
            "output_stream_start_failed device={name:?} error={error}"
        ));
        format!("cannot start audio output: {error}")
    })?;
    crate::audio_log::write(&format!(
        "output_stream_started device={name:?} channels={channels} sample_rate={sample_rate} sample_format={sample_format:?} buffer_size={:?} route_left_output={} route_right_output={}",
        stream_config.buffer_size,
        selection.first_channel + 1,
        selection.first_channel + 2,
    ));
    Ok(OutputRuntime {
        stream,
        mixer,
        channels,
        sample_rate,
        device_name: name,
    })
}

fn should_reopen_default_output(
    selection: &OutputSelection,
    opened_device: &str,
    system_default_device: &str,
) -> bool {
    selection.device_name.is_none() && opened_device != system_default_device
}

fn output_selection_matches_device(
    selection: &OutputSelection,
    opened_device: &str,
    system_default_device: Option<&str>,
) -> bool {
    selection.device_name.as_deref().or(system_default_device) == Some(opened_device)
}

/// Decode any rodio-supported bytes into a buffer. Hardware-free.
pub fn decode_bytes(data: &[u8]) -> Result<LoopBuffer, String> {
    // rodio 0.20's Symphonia adapter panics when its MP4 reader requests a
    // seek during initialization for Tablist's M4A files. Decode ISO BMFF
    // directly through Symphonia instead of letting that adapter panic.
    if data.get(4..8) == Some(b"ftyp") {
        return decode_isomp4(data).map(trim_aac_edge_silence);
    }
    decode_owned(data.to_vec())
}

/// Tablist AAC/M4A files can omit encoder pre-roll/padding metadata while
/// retaining short near-zero regions at the file edges. Trim only bounded
/// near-silence from the playback buffer; the downloaded source stays intact.
fn trim_aac_edge_silence(buffer: LoopBuffer) -> LoopBuffer {
    const WINDOW_MS: usize = 10;
    const MAX_PRIMING_MS: usize = 150;
    const SILENCE_PEAK: i32 = 64;

    let channels = buffer.channels.max(1) as usize;
    let rate = buffer.rate as usize;
    let frames = buffer.frames();
    if rate == 0 || frames == 0 {
        return buffer;
    }
    let window_frames = (rate.saturating_mul(WINDOW_MS) / 1000).max(1);
    let search_frames = (rate.saturating_mul(MAX_PRIMING_MS) / 1000).min(frames);
    let frame_has_audio = |frame: usize| {
        (0..channels)
            .any(|channel| (buffer.samples[frame * channels + channel] as i32).abs() > SILENCE_PEAK)
    };
    let leading_window = (0..search_frames)
        .step_by(window_frames)
        .find(|&start| (start..(start + window_frames).min(frames)).any(frame_has_audio));
    let trim_start = leading_window
        .and_then(|start| {
            (start..(start + window_frames).min(frames)).find(|&frame| frame_has_audio(frame))
        })
        .filter(|&start| start > 0)
        .unwrap_or(0);
    let trim_end = (0..search_frames)
        .step_by(window_frames)
        .find_map(|trimmed| {
            let end = frames - trimmed;
            let start = end
                .saturating_sub(window_frames)
                .max(frames - search_frames);
            (start..end)
                .rev()
                .find(|&frame| frame_has_audio(frame))
                .map(|frame| frame + 1)
        })
        .unwrap_or(frames);
    if trim_start == 0 && trim_end == frames {
        return buffer;
    }
    if trim_end <= trim_start {
        return buffer;
    }

    LoopBuffer {
        samples: buffer.samples[trim_start * channels..trim_end * channels].to_vec(),
        channels: buffer.channels,
        rate: buffer.rate,
    }
}

fn decode_isomp4(data: &[u8]) -> Result<LoopBuffer, String> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymphoniaError,
        formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
    };

    let source = MediaSourceStream::new(Box::new(Cursor::new(data.to_vec())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("m4a");
    let format_options = FormatOptions {
        enable_gapless: true,
        ..FormatOptions::default()
    };
    let mut probed = symphonia::default::get_probe()
        .format(&hint, source, &format_options, &MetadataOptions::default())
        .map_err(|error| format!("cannot inspect M4A audio: {error}"))?;
    let track = probed
        .format
        .default_track()
        .ok_or_else(|| "M4A audio has no default track".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| format!("cannot initialize M4A decoder: {error}"))?;

    let mut samples = Vec::new();
    let (mut channels, mut rate) = (0u16, 0u32);
    loop {
        let packet = match probed.format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(_)) => break,
            Err(error) => return Err(format!("cannot read M4A packet: {error}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|error| format!("cannot decode M4A packet: {error}"))?;
        channels = decoded.spec().channels.count() as u16;
        rate = decoded.spec().rate;
        let mut interleaved = SampleBuffer::<i16>::new(decoded.capacity() as u64, *decoded.spec());
        interleaved.copy_interleaved_ref(decoded);
        let decoded_samples = interleaved.samples();
        let channels = channels.max(1) as usize;
        let frame_count = decoded_samples.len() / channels;
        let trim_start = (packet.trim_start() as usize).min(frame_count);
        let trim_end = (packet.trim_end() as usize).min(frame_count - trim_start);
        let start_sample = trim_start * channels;
        let end_sample = (frame_count - trim_end) * channels;
        let max_samples =
            (MAX_DURATION_MS as u128 * rate as u128 / 1000).saturating_mul(channels as u128);
        if samples.len() as u128 + (end_sample - start_sample) as u128 > max_samples {
            return Err("track is over the 15 min practice limit".to_string());
        }
        samples.extend_from_slice(&decoded_samples[start_sample..end_sample]);
    }
    if samples.is_empty() || channels == 0 || rate == 0 {
        return Err("M4A stream contains no decodable audio frames".to_string());
    }
    let buffer = LoopBuffer {
        samples,
        channels,
        rate,
    };
    if buffer.duration_ms() > MAX_DURATION_MS {
        return Err(format!(
            "track is {} min, over the 15 min practice limit",
            buffer.duration_ms() / 60_000
        ));
    }
    Ok(buffer)
}

fn decode_owned(data: Vec<u8>) -> Result<LoopBuffer, String> {
    let dec = Decoder::new(Cursor::new(data)).map_err(|e| format!("cannot decode audio: {e}"))?;
    let (channels, rate) = (dec.channels(), dec.sample_rate());
    if channels == 0 || rate == 0 {
        return Err("decoded stream has no channels or rate".to_string());
    }
    let max_samples =
        (MAX_DURATION_MS as u128 * rate as u128 / 1000).saturating_mul(channels as u128) as usize;
    let samples: Vec<i16> = dec.take(max_samples.saturating_add(1)).collect();
    if samples.len() > max_samples {
        return Err("track is over the 15 min practice limit".to_string());
    }
    let buf = LoopBuffer {
        samples,
        channels,
        rate,
    };
    if buf.duration_ms() > MAX_DURATION_MS {
        return Err(format!(
            "track is {} min, over the 15 min practice limit",
            buf.duration_ms() / 60_000
        ));
    }
    Ok(buf)
}

pub fn ms_to_frames(ms: u64, rate: u32) -> usize {
    if rate == 0 {
        0
    } else {
        (ms as u128 * rate as u128 / 1000) as usize
    }
}

pub fn frames_to_ms(frames: usize, rate: u32) -> u64 {
    if rate == 0 {
        0
    } else {
        frames as u64 * 1000 / rate as u64
    }
}

/// Validated loop region in milliseconds.
pub fn check_region(start_ms: u64, end_ms: u64, duration_ms: u64) -> Result<(), String> {
    if end_ms > duration_ms {
        return Err(format!(
            "loop end {end_ms} ms exceeds duration {duration_ms} ms"
        ));
    }
    if start_ms >= end_ms {
        return Err("loop start must be before loop end".to_string());
    }
    Ok(())
}

struct Loaded {
    path: String,
    /// Load generation this track was requested with. Every `player_load`
    /// bumps the engine generation, so background jobs (decode, WSOLA,
    /// waveform) can tell whether their result still belongs to the live
    /// track. Superseded jobs are discarded, never applied.
    generation: u64,
    buf: Arc<LoopBuffer>,
    original_buf: Arc<LoopBuffer>,
    start_frame: usize,
    end_frame: usize,
    enabled: bool,
    source: LoopSource,
    resume_frame: usize,
    cursor: Arc<AtomicUsize>,
    volume: f32,
    speed: f32,
    /// Shared with the live source so speed changes take effect immediately.
    playback_speed: Arc<AtomicU32>,
    pitch_lock: bool,
    /// A WSOLA worker is stretching `original_buf` at `pitch_job_speed`.
    /// Playback continues untouched on the current buffer meanwhile.
    pitch_pending: bool,
    /// Id of the latest pitch job; older completions are discarded.
    pitch_job: u64,
    /// Latest requested rate. One running WSOLA job is allowed at a time.
    pitch_requested_speed: f32,
    pitch_job_speed: f32,
    pitch_error: Option<String>,
    /// Loop diagnostics populated by the frontend after loading a track
    /// from the library catalog. Not audio-engine state.
    loop_origin: String,
    loop_quality: f64,
}

impl Loaded {
    fn loop_region(
        &self,
        buf: Arc<LoopBuffer>,
        from_frame: usize,
        start_frame: usize,
        end_frame: usize,
        enabled: bool,
        cursor: Arc<AtomicUsize>,
    ) -> LoopRegion {
        LoopRegion::new(buf, from_frame, start_frame, end_frame, enabled, cursor)
            .with_speed_control(self.playback_speed.clone())
    }
}

/// What background readers observe: (path, load generation, decoded audio).
/// Cloned as a cheap `Arc` under a short lock; never held during computation.
type LoadedSnapshot = Option<(String, u64, Arc<LoopBuffer>)>;

/// A waveform job is current only if the live snapshot still matches the
/// (path, generation) it started from. Same path but newer generation
/// (reloaded track) also discards: the newer job owns that path now.
fn waveform_snapshot_current(loaded: &LoadedSnapshot, path: &str, generation: u64) -> bool {
    loaded
        .as_ref()
        .is_some_and(|(p, g, _)| p == path && *g == generation)
}

/// A pitch completion applies only if nothing superseded it: same track
/// generation, same job id, same speed, and pitch lock still on.
fn pitch_job_current(track: &Loaded, track_generation: u64, job: u64, speed: f32) -> bool {
    track.pitch_lock
        && track.pitch_pending
        && track.generation == track_generation
        && track.pitch_job == job
        && track.pitch_job_speed == speed
}

fn output_reopen_needed(
    selection: &OutputSelection,
    opened_device: &str,
    system_default_device: Option<&str>,
    target_available: bool,
) -> bool {
    !target_available
        || opened_device.is_empty()
        || (selection.device_name.is_none()
            && system_default_device.is_some_and(|default| {
                should_reopen_default_output(selection, opened_device, default)
            }))
}

fn pitch_job_needs_replacement(track: &Loaded, completed_speed: f32) -> bool {
    (track.pitch_requested_speed - completed_speed).abs() > f32::EPSILON
        || (track.speed - completed_speed).abs() > f32::EPSILON
}

/// A load completion applies only if it is still the latest request.
fn load_ready_current(pending: &Option<PendingLoad>, generation: u64, path: &str) -> bool {
    pending
        .as_ref()
        .is_some_and(|p| p.generation == generation && p.path == path)
}

/// Remap a frame cursor across buffers of (slightly) different lengths,
/// e.g. original vs WSOLA-stretched audio.
fn remap_frame(frame: usize, old_total: usize, new_total: usize) -> usize {
    if old_total == 0 {
        return 0;
    }
    ((frame as u128 * new_total as u128) / old_total as u128) as usize
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileIdentity {
    size: u64,
    modified: Option<std::time::SystemTime>,
}

#[derive(Clone, Debug)]
pub(crate) struct AudioLoadRequest {
    key: String,
    source: AudioLoadSource,
}

#[derive(Clone, Debug)]
enum AudioLoadSource {
    File {
        path: String,
    },
    EmbeddedSound {
        path: String,
        source_type: String,
        sound_id: u16,
        source_hash: String,
    },
}

impl AudioLoadRequest {
    pub(crate) fn file(key: String, path: String) -> Self {
        Self {
            key,
            source: AudioLoadSource::File { path },
        }
    }

    pub(crate) fn embedded_sound(
        key: String,
        path: String,
        source_type: String,
        sound_id: u16,
        source_hash: String,
    ) -> Self {
        Self {
            key,
            source: AudioLoadSource::EmbeddedSound {
                path,
                source_type,
                sound_id,
                source_hash,
            },
        }
    }

    fn key(&self) -> &str {
        &self.key
    }

    fn identity_path(&self) -> &str {
        match &self.source {
            AudioLoadSource::File { path } | AudioLoadSource::EmbeddedSound { path, .. } => path,
        }
    }

    pub(crate) fn decode(&self) -> Result<LoopBuffer, String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &self.source {
            AudioLoadSource::File { path } => read_and_decode(path),
            AudioLoadSource::EmbeddedSound {
                path,
                source_type,
                sound_id,
                source_hash,
            } => crate::library::decode_embedded_sound_file(
                path,
                source_type,
                *sound_id,
                source_hash,
            ),
        }))
        .map_err(|_| "cannot decode audio source: decoder failed".to_string())?
    }
}

fn file_identity(path: &str) -> Option<FileIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileIdentity {
        size: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

#[derive(Clone)]
struct PendingLoad {
    generation: u64,
    path: String,
    request: AudioLoadRequest,
    identity: Option<FileIdentity>,
}

#[derive(Clone)]
struct DecodedCacheEntry {
    path: String,
    identity: FileIdentity,
    buffer: Arc<LoopBuffer>,
}

fn decoded_cache_entry_matches(
    entry: &DecodedCacheEntry,
    path: &str,
    identity: &FileIdentity,
) -> bool {
    entry.path == path && entry.identity == *identity
}

pub struct Player {
    _output_stream: Option<cpal::Stream>,
    stream_generation: u64,
    output_device_name: String,
    output_error: Option<String>,
    output_mixer: Arc<DynamicMixerController<f32>>,
    output_channels: u16,
    output_sample_rate: u32,
    first_channel: u16,
    output_meter: Arc<OutputMeter>,
    sink: Option<Sink>,
    metronome_sink: Option<Sink>,
    metronome_bpm: Option<f32>,
    output_test_sink: Option<Sink>,
    output_test_resume_playback: bool,
    output_test_resume_metronome: bool,
    track: Option<Loaded>,
    /// Channel back to the engine loop, so background workers (decode,
    /// WSOLA) can post completions to be applied on the audio thread.
    tx: std::sync::mpsc::Sender<EngineCmd>,
    pitch_seq: u64,
}

impl Player {
    pub(crate) fn new(
        tx: std::sync::mpsc::Sender<EngineCmd>,
        selection: &OutputSelection,
    ) -> Result<Self, String> {
        let output_meter = Arc::new(OutputMeter::default());
        let stream_generation = 1;
        let output = open_output(
            selection,
            output_meter.clone(),
            tx.clone(),
            stream_generation,
        )?;
        Ok(Self {
            _output_stream: Some(output.stream),
            stream_generation,
            output_device_name: output.device_name,
            output_error: None,
            output_mixer: output.mixer,
            output_channels: output.channels,
            output_sample_rate: output.sample_rate,
            first_channel: selection.first_channel,
            output_meter,
            sink: None,
            metronome_sink: None,
            metronome_bpm: None,
            output_test_sink: None,
            output_test_resume_playback: false,
            output_test_resume_metronome: false,
            track: None,
            tx,
            pitch_seq: 0,
        })
    }

    fn set_output(&mut self, selection: &OutputSelection) -> Result<(), String> {
        if self.output_test_sink.is_some() {
            return Err("wait for the audio output test to finish".to_string());
        }
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|sink| !sink.is_paused() && !sink.empty());
        let metronome_was_playing = self.metronome_bpm.is_some();
        let had_sink = self.sink.is_some();
        if was_playing {
            if let Some(sink) = &self.sink {
                sink.pause();
            }
            if let Some(track) = self.track.as_mut() {
                track.resume_frame = track.cursor.load(Ordering::Relaxed);
            }
        }
        if metronome_was_playing {
            if let Some(sink) = &self.metronome_sink {
                sink.pause();
            }
        }
        // Stop the old route before attempting to open the new one. If the new
        // device rejects its stream configuration, playback remains safely
        // paused instead of continuing through the previously selected output.
        let stream_generation = self.stream_generation.wrapping_add(1);
        let output = open_output(
            selection,
            self.output_meter.clone(),
            self.tx.clone(),
            stream_generation,
        )?;
        let new_sink = if had_sink {
            if let Some(track) = self.track.as_mut() {
                let from = track.cursor.load(Ordering::Relaxed);
                track.resume_frame = from;
                let source = track.loop_region(
                    track.buf.clone(),
                    from,
                    track.start_frame,
                    track.end_frame,
                    track.enabled,
                    track.cursor.clone(),
                );
                let sink = match routed_sink(
                    &output.mixer,
                    output.sample_rate,
                    source,
                    track.volume,
                    if track.pitch_lock { 1.0 } else { track.speed },
                ) {
                    Ok(sink) => sink,
                    Err(error) => return Err(error.to_string()),
                };
                Some(sink)
            } else {
                None
            }
        } else {
            None
        };
        let new_metronome_sink = if let Some(bpm) = self.metronome_bpm {
            let buffer = Arc::new(metronome_buffer(output.sample_rate, bpm)?);
            let source = LoopRegion::new(
                buffer.clone(),
                0,
                0,
                buffer.frames(),
                true,
                Arc::new(AtomicUsize::new(0)),
            );
            Some(routed_sink(
                &output.mixer,
                output.sample_rate,
                source,
                0.5,
                1.0,
            )?)
        } else {
            None
        };

        self.sink = new_sink;
        self.metronome_sink = new_metronome_sink;
        self._output_stream = Some(output.stream);
        self.stream_generation = stream_generation;
        self.output_device_name = output.device_name;
        self.output_error = None;
        self.output_mixer = output.mixer;
        self.output_channels = output.channels;
        self.output_sample_rate = output.sample_rate;
        self.first_channel = selection.first_channel;
        crate::audio_log::write(&format!(
            "output_route_applied first_channel_index={} output_channels={} output_sample_rate={}",
            self.first_channel, self.output_channels, self.output_sample_rate
        ));
        if was_playing {
            if let Some(sink) = &self.sink {
                sink.play();
            }
        }
        if metronome_was_playing {
            if let Some(sink) = &self.metronome_sink {
                sink.play();
            }
        }
        Ok(())
    }

    fn set_metronome(&mut self, enabled: bool, bpm: f32) -> Result<(), String> {
        if self.output_test_sink.is_some() {
            return Err("wait for the audio output test to finish".to_string());
        }
        if !enabled {
            self.metronome_sink = None;
            self.metronome_bpm = None;
            return Ok(());
        }
        let buffer = Arc::new(metronome_buffer(self.output_sample_rate, bpm)?);
        let source = LoopRegion::new(
            buffer.clone(),
            0,
            0,
            buffer.frames(),
            true,
            Arc::new(AtomicUsize::new(0)),
        );
        let sink = routed_sink(
            &self.output_mixer,
            self.output_sample_rate,
            source,
            0.5,
            1.0,
        )?;
        sink.play();
        self.metronome_sink = Some(sink);
        self.metronome_bpm = Some(bpm);
        Ok(())
    }

    fn start_output_test(&mut self) -> Result<(), String> {
        if self.output_test_sink.is_some() {
            return Err("an audio output test is already running".to_string());
        }
        self.output_meter.reset();
        let buffer = Arc::new(output_test_buffer());
        let source = LoopRegion::new(
            buffer.clone(),
            0,
            0,
            buffer.frames(),
            false,
            Arc::new(AtomicUsize::new(0)),
        );
        let sink = routed_sink(
            &self.output_mixer,
            self.output_sample_rate,
            source,
            0.65,
            1.0,
        )?;

        let tx = self.tx.clone();
        let callback_sent = Arc::new(AtomicBool::new(false));
        let callback_guard = callback_sent.clone();
        sink.append(EmptyCallback::<i16>::new(Box::new(move || {
            if !callback_guard.swap(true, Ordering::Relaxed) {
                let _ = tx.send(EngineCmd::OutputTestFinished);
            }
        })));

        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|current| !current.is_paused() && !current.empty());
        if was_playing {
            if let Some(current) = &self.sink {
                current.pause();
            }
        }
        let metronome_was_playing = self
            .metronome_sink
            .as_ref()
            .is_some_and(|current| !current.is_paused() && !current.empty());
        if metronome_was_playing {
            if let Some(metronome) = &self.metronome_sink {
                metronome.pause();
            }
        }
        if let Some(track) = self.track.as_mut() {
            track.resume_frame = track.cursor.load(Ordering::Relaxed);
        }
        // The output-test tones own the stream briefly. Drop the track sink
        // after saving its exact frame, then recreate it when the test ends.
        self.sink = None;
        self.output_test_resume_playback = was_playing;
        self.output_test_resume_metronome = metronome_was_playing;
        sink.play();
        self.output_test_sink = Some(sink);
        crate::audio_log::write(&format!(
            "output_test_started left_hz=440 right_hz=660 volume=0.65 first_channel_index={} output_channels={} output_sample_rate={} playback_was_active={was_playing}",
            self.first_channel, self.output_channels, self.output_sample_rate
        ));
        Ok(())
    }

    fn finish_output_test(&mut self) {
        self.output_test_sink = None;
        let resume = std::mem::replace(&mut self.output_test_resume_playback, false);
        let resume_metronome = std::mem::replace(&mut self.output_test_resume_metronome, false);
        let (left_peak_pct, right_peak_pct) = self.output_meter.take_percentages();
        crate::audio_log::write(&format!(
            "output_test_finished left_peak_pct={left_peak_pct:.2} right_peak_pct={right_peak_pct:.2} resume_playback={resume}"
        ));
        if resume {
            let _ = self.play();
        }
        if resume_metronome {
            if let Some(sink) = &self.metronome_sink {
                sink.play();
            }
        }
    }

    fn fresh_sink(&self, source: LoopRegion, volume: f32, speed: f32) -> Result<Sink, String> {
        let sink = routed_sink(
            &self.output_mixer,
            self.output_sample_rate,
            source,
            volume,
            speed,
        )?;
        Ok(sink)
    }
}

/// Find the closest zero crossing in a 10 ms window without changing PCM.
/// For stereo, searches on mono but penalizes candidates where any channel
/// has high discontinuity.
fn snap_zero_crossing(buf: &LoopBuffer, requested: usize) -> usize {
    let frames = buf.frames();
    if frames < 2 {
        return requested.min(frames);
    }
    let radius = (buf.rate as usize / 100).max(1);
    let lo = requested.saturating_sub(radius).min(frames - 1);
    let hi = requested.saturating_add(radius).min(frames - 1);
    let channels = buf.channels.max(1) as usize;
    let mono = |frame: usize| {
        (0..channels)
            .map(|channel| {
                buf.samples
                    .get(frame * channels + channel)
                    .copied()
                    .unwrap_or(0) as i32
            })
            .sum::<i32>()
            / channels as i32
    };
    // For stereo, compute per-channel discontinuity at a candidate.
    let channel_discontinuity = |frame: usize| {
        (0..channels)
            .map(|ch| {
                let a = buf.samples.get(frame * channels + ch).copied().unwrap_or(0) as i32;
                let b = buf
                    .samples
                    .get((frame + 1) * channels + ch)
                    .copied()
                    .unwrap_or(0) as i32;
                (a - b).unsigned_abs()
            })
            .max()
            .unwrap_or(0)
    };
    let mut best: Option<(usize, u32, u32)> = None; // (frame, distance, discontinuity)
    for frame in lo..hi {
        let (a, b) = (mono(frame), mono(frame + 1));
        if (a <= 0 && b >= 0) || (a >= 0 && b <= 0) {
            let distance = (frame + 1).abs_diff(requested) as u32;
            let discontinuity = channel_discontinuity(frame);
            let candidate = (frame + 1, distance, discontinuity);
            if best.is_none_or(|current| (candidate.1, candidate.2) < (current.1, current.2)) {
                best = Some(candidate);
            }
        }
    }
    best.map(|(frame, _, _)| frame).unwrap_or_else(|| {
        // Fallback: frame of minimum local amplitude on mono.
        (lo..=hi)
            .min_by_key(|frame| mono(*frame).unsigned_abs())
            .unwrap_or(requested.min(frames))
    })
}

fn stretch_buffer(buffer: &LoopBuffer, tempo: f32) -> Result<LoopBuffer, String> {
    let samples: Vec<f32> = buffer
        .samples
        .iter()
        .map(|sample| *sample as f32 / 32768.0)
        .collect();
    let stretched = wsola::stretch(&samples, buffer.rate, buffer.channels, tempo)
        .map_err(|error| format!("cannot preserve pitch: {error}"))?;
    Ok(LoopBuffer {
        samples: stretched
            .into_iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect(),
        channels: buffer.channels,
        rate: buffer.rate,
    })
}

/// Worker entry point: WSOLA stretch with panics converted to job errors,
/// so a background failure can never leave a stuck "preparing" state.
/// Logs one `[olooper:metrics]` line with the stretch duration and shape.
fn stretch_job(buffer: &LoopBuffer, tempo: f32) -> Result<LoopBuffer, String> {
    let started = std::time::Instant::now();
    let frames_in = buffer.frames();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        stretch_buffer(buffer, tempo)
    }))
    .map_err(|_| "pitch processing failed".to_string())?;
    match &result {
        Ok(stretched) => eprintln!(
            "[olooper:metrics] op=stretch result=ok stretch_ms={} speed_pct={} frames_in={} frames_out={} rate={} ch={}",
            started.elapsed().as_millis(),
            tempo * 100.0,
            frames_in,
            stretched.frames(),
            stretched.rate,
            stretched.channels,
        ),
        Err(e) => eprintln!(
            "[olooper:metrics] op=stretch result=err stretch_ms={} speed_pct={} frames_in={} error={e}",
            started.elapsed().as_millis(),
            tempo * 100.0,
            frames_in,
        ),
    }
    result
}

/// Worker entry point: decode with panics converted to job errors.
fn decode_job(data: Vec<u8>) -> Result<LoopBuffer, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_bytes(&data)))
        .map_err(|_| "cannot decode audio: decoder failed".to_string())?
}

/// Worker entry point: capped file read + decode. Runs off the audio thread.
/// Logs one `[olooper:metrics]` line with read/decode durations and shape.
fn read_and_decode(path: &str) -> Result<LoopBuffer, String> {
    let started = std::time::Instant::now();
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot open file: {e}"))?;
    if meta.len() > MAX_INPUT_LEN {
        eprintln!(
            "[olooper:metrics] op=load result=err reason=oversize size_bytes={} path={path}",
            meta.len(),
        );
        return Err("file exceeds the 512 MiB limit".to_string());
    }
    let size = meta.len();
    let data = std::fs::read(path).map_err(|e| format!("cannot read file: {e}"))?;
    let read_ms = started.elapsed().as_millis();
    let decoded = std::time::Instant::now();
    let buf = decode_job(data);
    let decode_ms = decoded.elapsed().as_millis();
    match &buf {
        Ok(buf) => eprintln!(
            "[olooper:metrics] op=load result=ok read_ms={read_ms} decode_ms={decode_ms} size_bytes={size} frames={} rate={} ch={} duration_ms={} path={path}",
            buf.frames(),
            buf.rate,
            buf.channels,
            buf.duration_ms(),
        ),
        Err(e) => eprintln!(
            "[olooper:metrics] op=load result=err read_ms={read_ms} decode_ms={decode_ms} size_bytes={size} error={e} path={path}",
        ),
    }
    buf
}

impl Player {
    pub fn play(&mut self) -> Result<PlayerStatus, String> {
        if self.track.is_none() {
            return Err("nothing loaded".to_string());
        }
        if self.output_test_sink.is_some() {
            self.output_test_resume_playback = true;
            return Ok(self.status());
        }
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        if let Some(s) = &self.sink {
            if s.empty() {
                // Previous source exhausted (loop was off and reached the end).
            } else {
                s.play();
                return Ok(self.status());
            }
        }
        let volume = t.volume;
        let speed = if t.pitch_lock { 1.0 } else { t.speed };
        crate::audio_log::write(&format!(
            "playback_started source_channels={} source_sample_rate={} start_frame={} end_frame={} loop_enabled={} volume={volume:.3} speed={speed:.3} pitch_lock={}",
            t.buf.channels,
            t.buf.rate,
            t.start_frame,
            t.end_frame,
            t.enabled,
            t.pitch_lock,
        ));
        let src = t.loop_region(
            t.buf.clone(),
            t.resume_frame,
            t.start_frame,
            t.end_frame,
            t.enabled,
            t.cursor.clone(),
        );
        let sink = self.fresh_sink(src, volume, speed)?;
        sink.play();
        self.sink = Some(sink);
        Ok(self.status())
    }

    pub fn pause(&mut self) -> Result<PlayerStatus, String> {
        if self.output_test_sink.is_some() {
            let t = self.track.as_mut().ok_or("nothing loaded")?;
            t.resume_frame = t.cursor.load(Ordering::Relaxed);
            self.output_test_resume_playback = false;
            return Ok(self.status());
        }
        let (sink, t) = self
            .sink
            .as_ref()
            .zip(self.track.as_mut())
            .ok_or("nothing playing")?;
        t.resume_frame = t.cursor.load(Ordering::Relaxed);
        sink.pause();
        crate::audio_log::write(&format!("playback_paused frame={}", t.resume_frame));
        Ok(self.status())
    }

    pub fn stop(&mut self) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        self.output_test_resume_playback = false;
        self.sink = None; // drop first: no callback may advance the cursor after reset
        t.resume_frame = t.start_frame; // spec: stop returns to loop start
        t.cursor.store(t.start_frame, Ordering::Relaxed);
        crate::audio_log::write(&format!("playback_stopped frame={}", t.start_frame));
        Ok(self.status())
    }

    fn unload(&mut self) {
        self.pitch_seq = self.pitch_seq.wrapping_add(1);
        self.output_test_resume_playback = false;
        self.output_test_resume_metronome = false;
        self.output_test_sink = None;
        self.sink = None;
        self.track = None;
        self.output_meter.reset();
    }

    fn handle_stream_failure(&mut self, generation: u64, device_name: &str, error: &str) -> bool {
        if self.stream_generation != generation || self.output_device_name != device_name {
            return false;
        }
        if let Some(track) = self.track.as_mut() {
            if self
                .sink
                .as_ref()
                .is_some_and(|sink| !sink.is_paused() && !sink.empty())
            {
                track.resume_frame = track.cursor.load(Ordering::Relaxed);
            }
        }
        self.sink = None;
        self.metronome_sink = None;
        self.output_test_sink = None;
        self.output_test_resume_playback = false;
        self.output_test_resume_metronome = false;
        self._output_stream = None;
        self.output_device_name.clear();
        self.output_error = Some(format!("Audio output disconnected: {error}"));
        self.output_meter.reset();
        true
    }

    pub fn set_volume(&mut self, volume_pct: f32) -> Result<PlayerStatus, String> {
        if !(0.0..=100.0).contains(&volume_pct) {
            return Err("volume must be 0–100".to_string());
        }
        let v = volume_pct / 100.0;
        if let Some(t) = &mut self.track {
            t.volume = v;
        }
        if let Some(s) = &self.sink {
            s.set_volume(v);
        }
        Ok(self.status())
    }

    pub fn set_speed(&mut self, speed_pct: f32) -> Result<PlayerStatus, String> {
        if !(50.0..=200.0).contains(&speed_pct) {
            return Err("speed must be 50–200".to_string());
        }
        let speed = speed_pct / 100.0;
        let locked = {
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.speed = speed;
            track.pitch_error = None;
            if !track.pitch_lock {
                track
                    .playback_speed
                    .store(speed.to_bits(), Ordering::Relaxed);
            }
            track.pitch_lock
        };
        crate::audio_log::write(&format!(
            "playback_speed_changed speed={speed:.3} pitch_lock={locked}"
        ));
        if locked {
            // New speed supersedes any in-flight stretch; current audio
            // keeps playing untouched until the new buffer is ready.
            self.request_stretch();
        }
        Ok(self.status())
    }

    pub fn set_pitch_lock(&mut self, enabled: bool) -> Result<PlayerStatus, String> {
        if !enabled {
            let (original, speed) = self
                .track
                .as_ref()
                .map(|track| (track.original_buf.clone(), track.speed))
                .ok_or("nothing loaded")?;
            self.replace_active_buffer(original, speed)?;
            let seq = self.pitch_seq.wrapping_add(1);
            self.pitch_seq = seq;
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.pitch_lock = false;
            track.pitch_pending = false;
            track.pitch_job = seq;
            track.pitch_error = None;
            crate::audio_log::write(&format!(
                "pitch_lock_changed enabled=false speed={speed:.3}"
            ));
            return Ok(self.status());
        }
        let speed = self.track.as_ref().ok_or("nothing loaded")?.speed;
        if (speed - 1.0).abs() <= f32::EPSILON {
            let original = self.track.as_ref().unwrap().original_buf.clone();
            self.replace_active_buffer(original, 1.0)?;
        }
        let needs_stretch = {
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.pitch_lock = true;
            track.pitch_error = None;
            if (speed - 1.0).abs() <= f32::EPSILON {
                // No stretch needed at 100%: apply immediately, no worker.
                track.pitch_pending = false;
                false
            } else {
                true
            }
        };
        crate::audio_log::write(&format!(
            "pitch_lock_changed enabled=true speed={}",
            self.track.as_ref().map_or(1.0, |track| track.speed)
        ));
        if needs_stretch {
            self.request_stretch();
        }
        Ok(self.status())
    }

    /// Switch the live source buffer while preserving its proportional play
    /// position and loop bounds. A paused sink must be dropped too: resuming it
    /// would continue reading from the old buffer.
    fn replace_active_buffer(&mut self, buffer: Arc<LoopBuffer>, speed: f32) -> Result<(), String> {
        let Some(track) = self.track.as_ref() else {
            return Err("nothing loaded".to_string());
        };
        let old_frames = track.buf.frames().max(1);
        let new_frames = buffer.frames().max(1);
        let start = remap_frame(track.start_frame, old_frames, new_frames);
        let end = remap_frame(track.end_frame, old_frames, new_frames)
            .max(1)
            .min(new_frames);
        let from = remap_frame(track.cursor.load(Ordering::Relaxed), old_frames, new_frames);
        let resume = remap_frame(track.resume_frame, old_frames, new_frames);
        let (enabled, volume, cursor) = (track.enabled, track.volume, track.cursor.clone());
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|sink| !sink.is_paused() && !sink.empty());
        let replacement = if was_playing {
            let source =
                track.loop_region(buffer.clone(), from, start, end, enabled, cursor.clone());
            Some(self.fresh_sink(source, volume, speed)?)
        } else {
            None
        };

        self.sink = None;
        if let Some(sink) = replacement {
            sink.play();
            self.sink = Some(sink);
        }
        cursor.store(from, Ordering::Relaxed);
        let track = self.track.as_mut().ok_or("nothing loaded")?;
        track.buf = buffer;
        track.start_frame = start;
        track.end_frame = end;
        track.resume_frame = resume;
        track
            .playback_speed
            .store(speed.to_bits(), Ordering::Relaxed);
        Ok(())
    }

    /// Queue a WSOLA stretch of the original buffer at the current speed.
    /// Returns instantly: current playback is untouched and the worker posts
    /// `EngineCmd::PitchReady` for the audio thread to apply or discard.
    fn request_stretch(&mut self) {
        let seq = self.pitch_seq + 1;
        let job = self.track.as_mut().and_then(|track| {
            if !track.pitch_lock {
                return None;
            }
            track.pitch_requested_speed = track.speed;
            if track.pitch_pending {
                // WSOLA cannot be interrupted mid-call. Keep one worker and
                // let its completion schedule only this newest speed.
                return None;
            }
            track.pitch_pending = true;
            track.pitch_job = seq;
            track.pitch_job_speed = track.pitch_requested_speed;
            track.pitch_error = None;
            Some((
                track.original_buf.clone(),
                track.generation,
                track.pitch_requested_speed,
            ))
        });
        let Some((original, track_generation, speed)) = job else {
            return;
        };
        self.pitch_seq = seq;
        let tx = self.tx.clone();
        if std::thread::Builder::new()
            .name("olooper-stretch".to_string())
            .spawn(move || {
                let result = stretch_job(&original, speed);
                let _ = tx.send(EngineCmd::PitchReady {
                    track_generation,
                    job: seq,
                    speed,
                    result,
                });
            })
            .is_err()
        {
            // Never leave a stuck "preparing" state.
            if let Some(track) = self.track.as_mut() {
                if track.pitch_job == seq {
                    track.pitch_pending = false;
                    track.pitch_error = Some("cannot start pitch processing".to_string());
                }
            }
        }
    }

    pub fn set_loop(&mut self, start_ms: u64, end_ms: u64) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        let total = t.buf.frames();
        if total == 0 {
            return Err("track has no frames".to_string());
        }
        let start = ms_to_frames(start_ms, t.buf.rate).min(total);
        let end = ms_to_frames(end_ms, t.buf.rate).clamp(1, total);
        if start >= end {
            return Err("loop start must be before loop end".to_string());
        }
        t.start_frame = start;
        t.end_frame = end;
        t.source = LoopSource::Manual;
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        crate::audio_log::write(&format!(
            "loop_region_updated start_frame={start} end_frame={end} enabled={} was_playing={was_playing}",
            t.enabled
        ));
        if was_playing {
            // Restart the region from the new start for sample-accurate behavior.
            t.resume_frame = t.start_frame;
            let volume = t.volume;
            let speed = if t.pitch_lock { 1.0 } else { t.speed };
            let src = t.loop_region(
                t.buf.clone(),
                t.start_frame,
                t.start_frame,
                t.end_frame,
                t.enabled,
                t.cursor.clone(),
            );
            let sink = self.fresh_sink(src, volume, speed)?;
            sink.play();
            self.sink = Some(sink);
        } else {
            t.resume_frame = t.start_frame;
            t.cursor.store(t.start_frame, Ordering::Relaxed);
        }
        Ok(self.status())
    }

    /// Set loop directly with frame-precise values (no ms conversion).
    pub fn set_loop_frames(
        &mut self,
        start_frame: usize,
        end_frame: usize,
    ) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        let total = t.buf.frames();
        if start_frame >= end_frame || end_frame > total {
            return Err("loop start must be before loop end".to_string());
        }
        t.start_frame = start_frame;
        t.end_frame = end_frame;
        t.source = LoopSource::Manual;
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        crate::audio_log::write(&format!(
            "loop_region_updated start_frame={start_frame} end_frame={end_frame} enabled={} was_playing={was_playing}",
            t.enabled
        ));
        if was_playing {
            t.resume_frame = t.start_frame;
            let volume = t.volume;
            let speed = if t.pitch_lock { 1.0 } else { t.speed };
            let src = t.loop_region(
                t.buf.clone(),
                t.start_frame,
                t.start_frame,
                t.end_frame,
                t.enabled,
                t.cursor.clone(),
            );
            let sink = self.fresh_sink(src, volume, speed)?;
            sink.play();
            self.sink = Some(sink);
        } else {
            t.resume_frame = t.start_frame;
            t.cursor.store(t.start_frame, Ordering::Relaxed);
        }
        Ok(self.status())
    }

    pub fn set_loop_snapped(&mut self, start_ms: u64, end_ms: u64) -> Result<PlayerStatus, String> {
        let track = self.track.as_ref().ok_or("nothing loaded")?;
        let total = track.buf.frames();
        let start = ms_to_frames(start_ms, track.buf.rate).min(total);
        let end = ms_to_frames(end_ms, track.buf.rate).clamp(1, total.max(1));
        let start = snap_zero_crossing(&track.buf, start);
        let end = snap_zero_crossing(&track.buf, end);
        if start >= end {
            return Err("snapped loop start must be before end".to_string());
        }
        let _ = track;
        self.set_loop_frames(start, end)
    }

    pub fn set_loop_enabled(&mut self, enabled: bool) -> Result<PlayerStatus, String> {
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        if !was_playing {
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.enabled = enabled;
            crate::audio_log::write(&format!(
                "loop_enabled_changed enabled={enabled} start_frame={} end_frame={}",
                track.start_frame, track.end_frame
            ));
            return Ok(self.status());
        }
        let (src, volume, speed) = {
            let t = self.track.as_mut().ok_or("nothing loaded")?;
            t.enabled = enabled;
            crate::audio_log::write(&format!(
                "loop_enabled_changed enabled={enabled} start_frame={} end_frame={}",
                t.start_frame, t.end_frame
            ));
            // LoopRegion captures this flag when created, so rebuild the
            // source immediately instead of waiting for another transport action.
            let cursor = t.cursor.load(Ordering::Relaxed);
            t.resume_frame = cursor;
            (
                t.loop_region(
                    t.buf.clone(),
                    cursor,
                    t.start_frame,
                    t.end_frame,
                    enabled,
                    t.cursor.clone(),
                ),
                t.volume,
                if t.pitch_lock { 1.0 } else { t.speed },
            )
        };
        let sink = self.fresh_sink(src, volume, speed)?;
        sink.play();
        self.sink = Some(sink);
        Ok(self.status())
    }

    /// Seek anywhere in the track. Loop region/mode unchanged; a playing
    /// source restarts at the target for sample-accurate behavior.
    pub fn seek(&mut self, position_ms: u64) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        let total = t.buf.frames();
        let from = ms_to_frames(position_ms.min(t.buf.duration_ms()), t.buf.rate).min(total);
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        t.resume_frame = from;
        t.cursor.store(from, Ordering::Relaxed);
        if was_playing {
            let volume = t.volume;
            let enabled = t.enabled;
            let speed = if t.pitch_lock { 1.0 } else { t.speed };
            let src = t.loop_region(
                t.buf.clone(),
                from,
                t.start_frame,
                t.end_frame,
                enabled,
                t.cursor.clone(),
            );
            let sink = self.fresh_sink(src, volume, speed)?;
            sink.play();
            self.sink = Some(sink);
        }
        Ok(self.status())
    }

    pub fn status(&self) -> PlayerStatus {
        let (output_left_level_pct, output_right_level_pct) = self.output_meter.take_percentages();
        match &self.track {
            None => PlayerStatus {
                output_left_level_pct,
                output_right_level_pct,
                output_error: self.output_error.clone(),
                ..PlayerStatus::empty()
            },
            Some(t) => {
                let playing = self
                    .sink
                    .as_ref()
                    .is_some_and(|s| !s.is_paused() && !s.empty());
                let position = t.cursor.load(Ordering::Relaxed);
                PlayerStatus {
                    loaded: true,
                    path: Some(t.path.clone()),
                    playing,
                    position_ms: frames_to_ms(position, t.buf.rate),
                    duration_ms: t.buf.duration_ms(),
                    loop_start_ms: frames_to_ms(t.start_frame, t.buf.rate),
                    loop_end_ms: frames_to_ms(t.end_frame, t.buf.rate),
                    loop_enabled: t.enabled,
                    volume_pct: t.volume * 100.0,
                    speed_pct: t.speed * 100.0,
                    pitch_lock: t.pitch_lock,
                    pitch_preparing: t.pitch_pending,
                    pitch_error: t.pitch_error.clone(),
                    loading: false,
                    load_error: None,
                    position_frame: position,
                    loop_start_frame: t.start_frame,
                    loop_end_frame: t.end_frame,
                    total_frames: t.buf.frames(),
                    loop_origin: t.loop_origin.clone(),
                    loop_quality: t.loop_quality,
                    output_left_level_pct,
                    output_right_level_pct,
                    output_error: self.output_error.clone(),
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerStatus {
    pub loaded: bool,
    pub path: Option<String>,
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub loop_start_ms: u64,
    pub loop_end_ms: u64,
    pub loop_enabled: bool,
    pub volume_pct: f32,
    pub speed_pct: f32,
    pub pitch_lock: bool,
    /// A WSOLA stretch worker is running; current audio plays untouched.
    pub pitch_preparing: bool,
    pub pitch_error: Option<String>,
    /// A background decode is running; previous audio (if any) still live.
    pub loading: bool,
    pub load_error: Option<String>,
    /// Frame-precise values for internal use.
    pub position_frame: usize,
    pub loop_start_frame: usize,
    pub loop_end_frame: usize,
    pub total_frames: usize,
    /// Loop diagnostics from the library catalog.
    pub loop_origin: String,
    pub loop_quality: f64,
    /// Digital peak sent to each routed channel since the last status read.
    pub output_left_level_pct: f32,
    pub output_right_level_pct: f32,
    pub output_error: Option<String>,
}

impl PlayerStatus {
    pub fn empty() -> Self {
        Self {
            loaded: false,
            path: None,
            playing: false,
            position_ms: 0,
            duration_ms: 0,
            loop_start_ms: 0,
            loop_end_ms: 0,
            loop_enabled: true,
            volume_pct: 80.0,
            speed_pct: 100.0,
            pitch_lock: false,
            pitch_preparing: false,
            pitch_error: None,
            loading: false,
            load_error: None,
            position_frame: 0,
            loop_start_frame: 0,
            loop_end_frame: 0,
            total_frames: 0,
            loop_origin: "manual".to_string(),
            loop_quality: 1.0,
            output_left_level_pct: 0.0,
            output_right_level_pct: 0.0,
            output_error: None,
        }
    }
}

/// Lazily-initialized engine: the app boots without an audio device; the
/// first `load`/`play` surfaces the error instead.
///
/// The engine lives on a dedicated audio thread because rodio's
/// `OutputStream`/`Sink` are `!Send`. Commands cross the boundary over a
/// channel; `EngineClient` is `Send + Sync` and safe in Tauri state.
pub struct Engine {
    player: Option<Player>,
    output_selection: OutputSelection,
    last_default_output_failure: Option<(String, std::time::Instant)>,
    /// Cloned into background workers so completions re-enter this loop.
    tx: std::sync::mpsc::Sender<EngineCmd>,
    pending_volume: f32,
    /// Bumped on every load request; jobs carry the generation they were
    /// spawned for and are discarded when a newer load supersedes them.
    generation: u64,
    loaded_buffer: std::sync::Arc<std::sync::RwLock<LoadedSnapshot>>,
    pending_load: Option<PendingLoad>,
    /// A decode worker is currently running. Requests received while it runs
    /// replace `pending_load`; only the newest one starts next.
    decode_running: bool,
    last_load_error: Option<String>,
    decoded_cache: VecDeque<DecodedCacheEntry>,
    decoded_cache_bytes: usize,
}

type Reply = std::sync::mpsc::Sender<Result<PlayerStatus, String>>;

/// Internal commands. `pub(crate)` only because the type appears in
/// `pub(crate)` constructors; never sent across the Tauri boundary.
pub(crate) enum EngineCmd {
    Load {
        request: AudioLoadRequest,
        reply: Reply,
    },
    /// Posted by the decode worker. Applied only if still the latest load.
    LoadReady {
        generation: u64,
        path: String,
        request: AudioLoadRequest,
        identity: Option<FileIdentity>,
        result: Result<LoopBuffer, String>,
    },
    OutputFailed {
        generation: u64,
        device_name: String,
        error: String,
    },
    Play {
        reply: Reply,
    },
    Pause {
        reply: Reply,
    },
    Stop {
        reply: Reply,
    },
    Unload {
        reply: Reply,
    },
    SetVolume {
        volume_pct: f32,
        reply: Reply,
    },
    SetMetronome {
        enabled: bool,
        bpm: f32,
        reply: Reply,
    },
    SetSpeed {
        speed_pct: f32,
        reply: Reply,
    },
    SetPitchLock {
        enabled: bool,
        reply: Reply,
    },
    /// Posted by the WSOLA worker. Applied only if track, speed, lock
    /// state, and job id still match.
    PitchReady {
        track_generation: u64,
        job: u64,
        speed: f32,
        result: Result<LoopBuffer, String>,
    },
    SetLoop {
        start_ms: u64,
        end_ms: u64,
        reply: Reply,
    },
    SetLoopSnapped {
        start_ms: u64,
        end_ms: u64,
        reply: Reply,
    },
    SetLoopEnabled {
        enabled: bool,
        reply: Reply,
    },
    Seek {
        position_ms: u64,
        reply: Reply,
    },
    SetDiagnostics {
        loop_origin: String,
        loop_quality: f64,
        reply: Reply,
    },
    SetOutput {
        selection: OutputSelection,
        reply: Reply,
    },
    TestOutput {
        selection: OutputSelection,
        reply: Reply,
    },
    OutputTestFinished,
    Status {
        reply: Reply,
    },
}

impl Engine {
    pub(crate) fn new(
        loaded_buffer: std::sync::Arc<std::sync::RwLock<LoadedSnapshot>>,
        tx: std::sync::mpsc::Sender<EngineCmd>,
    ) -> Self {
        Self {
            player: None,
            output_selection: OutputSelection::default(),
            last_default_output_failure: None,
            tx,
            pending_volume: 0.8,
            generation: 0,
            loaded_buffer,
            pending_load: None,
            decode_running: false,
            last_load_error: None,
            decoded_cache: VecDeque::new(),
            decoded_cache_bytes: 0,
        }
    }

    fn ensure(&mut self) -> Result<&mut Player, String> {
        if self.player.is_none() {
            let tx = self.tx.clone();
            self.player = Some(Player::new(tx, &self.output_selection)?);
        }
        Ok(self.player.as_mut().expect("just created"))
    }

    fn status(&self) -> PlayerStatus {
        let mut st = self.player.as_ref().map_or_else(
            || PlayerStatus {
                volume_pct: self.pending_volume * 100.0,
                ..PlayerStatus::empty()
            },
            |p| p.status(),
        );
        st.loading = self.pending_load.is_some();
        st.load_error = self.last_load_error.clone();
        st
    }

    fn run(mut self, rx: std::sync::mpsc::Receiver<EngineCmd>) {
        let mut next_default_output_check =
            std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            let wait =
                next_default_output_check.saturating_duration_since(std::time::Instant::now());
            let cmd = match rx.recv_timeout(wait) {
                Ok(cmd) => cmd,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.follow_system_default_output();
                    next_default_output_check =
                        std::time::Instant::now() + std::time::Duration::from_secs(1);
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match cmd {
                // Worker completions carry no reply: they were requested
                // by an earlier command whose reply already went out.
                EngineCmd::LoadReady {
                    generation,
                    path,
                    request,
                    identity,
                    result,
                } => self.cmd_load_ready(generation, path, request, identity, result),
                EngineCmd::OutputFailed {
                    generation,
                    device_name,
                    error,
                } => self.cmd_output_failed(generation, &device_name, &error),
                EngineCmd::PitchReady {
                    track_generation,
                    job,
                    speed,
                    result,
                } => self.cmd_pitch_ready(track_generation, job, speed, result),
                EngineCmd::Load { request, reply } => {
                    let _ = reply.send(self.cmd_load_request(request));
                }
                EngineCmd::Play { reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.play()));
                }
                EngineCmd::Pause { reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.pause()));
                }
                EngineCmd::Stop { reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.stop()));
                }
                EngineCmd::Unload { reply } => {
                    let result = self.cmd_unload();
                    let _ = reply.send(result.map(|()| self.status()));
                }
                EngineCmd::SetVolume { volume_pct, reply } => {
                    let _ = reply.send(self.cmd_volume(volume_pct));
                }
                EngineCmd::SetMetronome {
                    enabled,
                    bpm,
                    reply,
                } => {
                    let _ = reply.send(self.cmd_set_metronome(enabled, bpm));
                }
                EngineCmd::SetSpeed { speed_pct, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_speed(speed_pct)));
                }
                EngineCmd::SetPitchLock { enabled, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_pitch_lock(enabled)));
                }
                EngineCmd::SetLoop {
                    start_ms,
                    end_ms,
                    reply,
                } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_loop(start_ms, end_ms)));
                }
                EngineCmd::SetLoopSnapped {
                    start_ms,
                    end_ms,
                    reply,
                } => {
                    let _ = reply.send(
                        self.ensure()
                            .and_then(|p| p.set_loop_snapped(start_ms, end_ms)),
                    );
                }
                EngineCmd::SetLoopEnabled { enabled, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_loop_enabled(enabled)));
                }
                EngineCmd::Seek { position_ms, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.seek(position_ms)));
                }
                EngineCmd::SetDiagnostics {
                    loop_origin,
                    loop_quality,
                    reply,
                } => {
                    if let Some(p) = self.player.as_mut() {
                        if let Some(t) = p.track.as_mut() {
                            t.loop_origin = loop_origin;
                            t.loop_quality = loop_quality;
                        }
                    }
                    let _ = reply.send(Ok(self.status()));
                }
                EngineCmd::SetOutput { selection, reply } => {
                    let result = self.cmd_set_output(selection);
                    let _ = reply.send(result.map(|()| self.status()));
                }
                EngineCmd::TestOutput { selection, reply } => {
                    let result = self.cmd_test_output(selection);
                    let _ = reply.send(result);
                }
                EngineCmd::OutputTestFinished => {
                    if let Some(player) = self.player.as_mut() {
                        player.finish_output_test();
                    }
                }
                EngineCmd::Status { reply } => {
                    let _ = reply.send(Ok(self.status()));
                }
            }
            if std::time::Instant::now() >= next_default_output_check {
                self.follow_system_default_output();
                next_default_output_check =
                    std::time::Instant::now() + std::time::Duration::from_secs(1);
            }
        }
    }

    fn follow_system_default_output(&mut self) {
        let Some(player) = self.player.as_ref() else {
            return;
        };
        if player.output_test_sink.is_some() {
            return;
        }
        let default_name = cpal::default_host()
            .default_output_device()
            .and_then(|device| device.name().ok());
        let target_name = self
            .output_selection
            .device_name
            .clone()
            .or_else(|| default_name.clone());
        let Some(target_name) = target_name else {
            return;
        };
        let target_present = cpal::default_host().output_devices().ok().map(|devices| {
            devices
                .filter_map(|device| device.name().ok())
                .any(|name| name == target_name)
        });
        if target_present == Some(false) && player.output_device_name == target_name {
            let generation = player.stream_generation;
            if let Some(player) = self.player.as_mut() {
                player.handle_stream_failure(generation, &target_name, "device is unavailable");
            }
        }
        let Some(player) = self.player.as_ref() else {
            return;
        };
        let needs_reopen = output_reopen_needed(
            &self.output_selection,
            &player.output_device_name,
            default_name.as_deref(),
            target_present.unwrap_or(true),
        );
        if !needs_reopen {
            if self
                .last_default_output_failure
                .as_ref()
                .is_some_and(|(failed_name, _)| failed_name != &target_name)
            {
                self.last_default_output_failure = None;
            }
            return;
        }
        if self
            .last_default_output_failure
            .as_ref()
            .is_some_and(|(failed_name, failed_at)| {
                failed_name == &target_name
                    && failed_at.elapsed() < std::time::Duration::from_secs(5)
            })
        {
            return;
        }

        crate::audio_log::write(&format!(
            "audio_output_recovery_attempt old={:?} target={target_name:?}",
            player.output_device_name
        ));
        let result = self
            .player
            .as_mut()
            .expect("player was checked above")
            .set_output(&self.output_selection);
        match result {
            Ok(()) => {
                self.last_default_output_failure = None;
                crate::audio_log::write(&format!(
                    "audio_output_recovery_applied device={target_name:?}"
                ));
            }
            Err(error) => {
                self.last_default_output_failure =
                    Some((target_name.clone(), std::time::Instant::now()));
                crate::audio_log::write(&format!(
                    "audio_output_recovery_failed device={target_name:?} error={error}"
                ));
            }
        }
    }

    fn cmd_output_failed(&mut self, generation: u64, device_name: &str, error: &str) {
        let failed = self
            .player
            .as_mut()
            .is_some_and(|player| player.handle_stream_failure(generation, device_name, error));
        if failed {
            self.last_default_output_failure = None;
        }
    }

    fn cmd_set_output(&mut self, selection: OutputSelection) -> Result<(), String> {
        // Validate the exact channel/rate/format/buffer tuple even while the
        // lazy player has not opened an output stream yet.
        select_output_config(&selection)?;
        let output_matches = self.player.as_ref().is_none_or(|player| {
            let system_default = if selection.device_name.is_none() {
                cpal::default_host()
                    .default_output_device()
                    .and_then(|device| device.name().ok())
            } else {
                None
            };
            output_selection_matches_device(
                &selection,
                &player.output_device_name,
                system_default.as_deref(),
            )
        });
        if selection == self.output_selection && output_matches {
            return Ok(());
        }
        if let Some(player) = self.player.as_mut() {
            player.set_output(&selection)?;
        }
        self.output_selection = selection;
        self.last_default_output_failure = None;
        Ok(())
    }

    fn cmd_test_output(&mut self, selection: OutputSelection) -> Result<PlayerStatus, String> {
        self.cmd_set_output(selection)?;
        self.ensure()?.start_output_test()?;
        Ok(self.status())
    }

    fn cmd_set_metronome(&mut self, enabled: bool, bpm: f32) -> Result<PlayerStatus, String> {
        if enabled {
            self.ensure()?.set_metronome(true, bpm)?;
        } else if let Some(player) = self.player.as_mut() {
            player.set_metronome(false, bpm)?;
        }
        Ok(self.status())
    }

    fn cmd_unload(&mut self) -> Result<(), String> {
        self.generation = self.generation.wrapping_add(1);
        self.pending_load = None;
        self.last_load_error = None;
        *self
            .loaded_buffer
            .write()
            .map_err(|error| format!("cannot clear loaded track: {error}"))? = None;
        if let Some(player) = self.player.as_mut() {
            player.unload();
        }
        Ok(())
    }

    /// Start a background decode and return a loading status instantly.
    /// Previous audio keeps playing until a valid buffer arrives.
    fn cmd_load_request(&mut self, request: AudioLoadRequest) -> Result<PlayerStatus, String> {
        let path = request.key().to_string();
        self.generation += 1;
        let generation = self.generation;
        // Any previous decode belongs to an older request, including when the
        // latest request is satisfied immediately from the decoded cache.
        self.pending_load = None;
        self.last_load_error = None;
        let mut identity = file_identity(request.identity_path());
        self.decoded_cache
            .retain(|entry| entry.path != path || Some(entry.identity.clone()) == identity);
        self.decoded_cache_bytes = self
            .decoded_cache
            .iter()
            .map(|entry| entry.buffer.memory_bytes())
            .sum();
        if let Some(index) = identity.as_ref().and_then(|identity| {
            self.decoded_cache
                .iter()
                .position(|entry| decoded_cache_entry_matches(entry, &path, identity))
        }) {
            let entry = self
                .decoded_cache
                .remove(index)
                .expect("cache index exists");
            let buffer = entry.buffer;
            self.decoded_cache_bytes = self
                .decoded_cache_bytes
                .saturating_sub(buffer.memory_bytes());
            self.apply_loaded(path, generation, identity.take(), buffer);
            return Ok(self.status());
        }
        self.pending_load = Some(PendingLoad {
            generation,
            path: path.clone(),
            request,
            identity: identity.clone(),
        });
        if self.decode_running {
            return Ok(self.status());
        }
        self.start_pending_decode();
        Ok(self.status())
    }

    fn start_pending_decode(&mut self) {
        let Some(pending) = self.pending_load.clone() else {
            return;
        };
        self.decode_running = true;
        let tx = self.tx.clone();
        if std::thread::Builder::new()
            .name("olooper-decode".to_string())
            .spawn(move || {
                let result = pending.request.decode();
                let _ = tx.send(EngineCmd::LoadReady {
                    generation: pending.generation,
                    path: pending.path,
                    request: pending.request,
                    identity: pending.identity,
                    result,
                });
            })
            .is_err()
        {
            self.decode_running = false;
            self.pending_load = None;
            self.last_load_error = Some("cannot start background decode".to_string());
        }
    }

    /// Swap in a decoded buffer only if it is still the latest request and
    /// valid. Failures preserve the previous track untouched.
    fn cmd_load_ready(
        &mut self,
        generation: u64,
        path: String,
        request: AudioLoadRequest,
        identity: Option<FileIdentity>,
        result: Result<LoopBuffer, String>,
    ) {
        self.decode_running = false;
        if !load_ready_current(&self.pending_load, generation, &path) {
            // A newer selection arrived while this worker was busy. Discard
            // its result and start exactly that newest request.
            self.start_pending_decode();
            return;
        }
        self.pending_load = None;
        if file_identity(request.identity_path()) != identity {
            self.last_load_error =
                Some("audio file changed while it was loading; load it again".to_string());
            return;
        }
        let buf = match result {
            Err(e) => {
                crate::audio_log::write(&format!("audio_decode_failed error={e}"));
                self.last_load_error = Some(e);
                return;
            }
            Ok(buf) => buf,
        };
        self.apply_loaded(path, generation, identity, Arc::new(buf));
    }

    fn apply_loaded(
        &mut self,
        path: String,
        generation: u64,
        identity: Option<FileIdentity>,
        buf: Arc<LoopBuffer>,
    ) {
        let vol = self.pending_volume;
        let applied: Result<(String, u64, Arc<LoopBuffer>), String> = (|| {
            let p = self.ensure()?;
            p.sink = None; // hard stop of previous audio
            let original_buf = buf.clone();
            let total = buf.frames();
            p.track = Some(Loaded {
                path,
                generation,
                buf,
                original_buf,
                start_frame: 0,
                end_frame: total,
                enabled: true,
                source: LoopSource::Manual,
                resume_frame: 0,
                cursor: Arc::new(AtomicUsize::new(0)),
                volume: vol,
                speed: 1.0,
                playback_speed: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                pitch_lock: false,
                pitch_pending: false,
                pitch_job: 0,
                pitch_requested_speed: 1.0,
                pitch_job_speed: 1.0,
                pitch_error: None,
                loop_origin: "manual".to_string(),
                loop_quality: 1.0,
            });
            let t = p.track.as_ref().expect("track just set");
            Ok((t.path.clone(), t.generation, t.buf.clone()))
        })();
        match applied {
            Ok(snapshot) => {
                crate::audio_log::write(&format!(
                    "decoded_audio_loaded frames={} channels={} sample_rate={} duration_ms={}",
                    snapshot.2.frames(),
                    snapshot.2.channels,
                    snapshot.2.rate,
                    snapshot.2.duration_ms(),
                ));
                if let Some(identity) = identity {
                    self.cache_decoded(snapshot.0.clone(), identity, snapshot.2.clone());
                }
                let path = snapshot.0.clone();
                let published = std::time::Instant::now();
                if self
                    .loaded_buffer
                    .write()
                    .map(|mut g| *g = Some(snapshot))
                    .is_err()
                {
                    self.last_load_error = Some("audio engine stopped".to_string());
                }
                eprintln!(
                    "[olooper:metrics] op=load_apply lock_wait_ms={} path={path}",
                    published.elapsed().as_millis(),
                );
            }
            Err(e) => self.last_load_error = Some(e),
        }
    }

    fn cache_decoded(&mut self, path: String, identity: FileIdentity, buffer: Arc<LoopBuffer>) {
        self.decoded_cache.retain(|entry| entry.path != path);
        self.decoded_cache_bytes = self
            .decoded_cache
            .iter()
            .map(|entry| entry.buffer.memory_bytes())
            .sum();
        let bytes = buffer.memory_bytes();
        if bytes > DECODE_CACHE_MAX_BYTES {
            return;
        }
        while self.decoded_cache.len() >= DECODE_CACHE_MAX_TRACKS
            || self.decoded_cache_bytes.saturating_add(bytes) > DECODE_CACHE_MAX_BYTES
        {
            let Some(evicted) = self.decoded_cache.pop_front() else {
                break;
            };
            self.decoded_cache_bytes = self
                .decoded_cache_bytes
                .saturating_sub(evicted.buffer.memory_bytes());
        }
        self.decoded_cache_bytes += bytes;
        self.decoded_cache.push_back(DecodedCacheEntry {
            path,
            identity,
            buffer,
        });
    }

    /// Swap in a stretched buffer only if track, speed, lock, and job all
    /// still match. Anything else means the user moved on → discard.
    fn cmd_pitch_ready(
        &mut self,
        track_generation: u64,
        job: u64,
        speed: f32,
        result: Result<LoopBuffer, String>,
    ) {
        let Some(p) = self.player.as_mut() else {
            return;
        };
        let Some(t) = p.track.as_mut() else {
            return;
        };
        if !pitch_job_current(t, track_generation, job, speed) {
            return; // superseded → discard
        }
        if pitch_job_needs_replacement(t, speed) {
            // The running job is obsolete, but it was the only permitted
            // worker. Start exactly one replacement for the newest request.
            t.pitch_pending = false;
            p.request_stretch();
            return;
        }
        match result {
            Err(e) => {
                t.pitch_pending = false;
                t.pitch_error = Some(e);
            }
            Ok(stretched) => {
                let old_frames = t.buf.frames().max(1);
                let new_frames = stretched.frames().max(1);
                let new_buf = Arc::new(stretched);
                // Loop points live in the active buffer timeline. WSOLA can
                // change its frame count, so transfer them proportionally.
                let new_start = remap_frame(t.start_frame, old_frames, new_frames);
                let new_end = remap_frame(t.end_frame, old_frames, new_frames)
                    .max(1)
                    .min(new_frames);
                // Keep the listening position across the buffer swap.
                let resume_frame = remap_frame(t.resume_frame, old_frames, new_frames);
                let from = remap_frame(t.cursor.load(Ordering::Relaxed), old_frames, new_frames);
                let (cursor, volume, enabled) = (t.cursor.clone(), t.volume, t.enabled);
                let was_playing = p
                    .sink
                    .as_ref()
                    .is_some_and(|s| !s.is_paused() && !s.empty());
                if was_playing {
                    // Restart on the stretched buffer at locked (1.0x) rate.
                    let src =
                        t.loop_region(new_buf.clone(), from, new_start, new_end, enabled, cursor);
                    let sink = match routed_sink(
                        &p.output_mixer,
                        p.output_sample_rate,
                        src,
                        volume,
                        1.0,
                    ) {
                        Ok(sink) => sink,
                        Err(error) => {
                            t.pitch_pending = false;
                            t.pitch_error = Some(error.to_string());
                            return;
                        }
                    };
                    sink.play();
                    p.sink = Some(sink);
                }
                t.playback_speed.store(1.0f32.to_bits(), Ordering::Relaxed);
                t.buf = new_buf;
                t.start_frame = new_start;
                t.end_frame = new_end;
                t.resume_frame = resume_frame;
                t.cursor.store(from, Ordering::Relaxed);
                t.pitch_pending = false;
                t.pitch_error = None;
            }
        }
    }

    fn cmd_volume(&mut self, volume_pct: f32) -> Result<PlayerStatus, String> {
        if !(0.0..=100.0).contains(&volume_pct) {
            return Err("volume must be 0–100".to_string());
        }
        self.pending_volume = volume_pct / 100.0;
        match &mut self.player {
            Some(p) => p.set_volume(volume_pct),
            None => Ok(PlayerStatus {
                volume_pct,
                ..PlayerStatus::empty()
            }),
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        // Throwaway channel: completions posted here are dropped, which is
        // fine for a default engine with no command loop draining it.
        let (tx, _rx) = std::sync::mpsc::channel();
        Self::new(std::sync::Arc::new(std::sync::RwLock::new(None)), tx)
    }
}

#[derive(Debug, Clone)]
pub struct EngineClient {
    tx: std::sync::mpsc::Sender<EngineCmd>,
    loaded_buffer: std::sync::Arc<std::sync::RwLock<LoadedSnapshot>>,
    /// Serializes cache misses so repeated track switches do not run multiple
    /// full-buffer peak scans concurrently. It never guards audio state.
    waveform_compute_lock: std::sync::Arc<std::sync::Mutex<()>>,
}

impl EngineClient {
    fn call(&self, mk: impl FnOnce(Reply) -> EngineCmd) -> Result<PlayerStatus, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.tx
            .send(mk(tx))
            .map_err(|_| "audio engine stopped".to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|error| match error {
                std::sync::mpsc::RecvTimeoutError::Timeout => {
                    "audio engine did not respond within 30 seconds".to_string()
                }
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    "audio engine stopped".to_string()
                }
            })?
    }

    pub fn set_output(&self, selection: OutputSelection) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetOutput { selection, reply })
    }

    pub fn test_output(&self, selection: OutputSelection) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::TestOutput { selection, reply })
    }

    pub fn load(&self, path: String) -> Result<PlayerStatus, String> {
        let request = AudioLoadRequest::file(path.clone(), path);
        self.load_request(request)
    }

    pub(crate) fn load_request(&self, request: AudioLoadRequest) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Load { request, reply })
    }

    pub fn play(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Play { reply })
    }

    pub fn pause(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Pause { reply })
    }

    pub fn stop(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Stop { reply })
    }

    pub fn unload(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Unload { reply })
    }

    pub fn set_volume(&self, volume_pct: f32) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetVolume { volume_pct, reply })
    }

    pub fn set_metronome(&self, enabled: bool, bpm: f32) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetMetronome {
            enabled,
            bpm,
            reply,
        })
    }

    pub fn set_speed(&self, speed_pct: f32) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetSpeed { speed_pct, reply })
    }

    pub fn set_pitch_lock(&self, enabled: bool) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetPitchLock { enabled, reply })
    }

    pub fn set_loop(&self, start_ms: u64, end_ms: u64) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetLoop {
            start_ms,
            end_ms,
            reply,
        })
    }

    pub fn set_loop_snapped(&self, start_ms: u64, end_ms: u64) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetLoopSnapped {
            start_ms,
            end_ms,
            reply,
        })
    }

    pub fn set_loop_enabled(&self, enabled: bool) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetLoopEnabled { enabled, reply })
    }

    pub fn seek(&self, position_ms: u64) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Seek { position_ms, reply })
    }

    pub fn set_diagnostics(
        &self,
        loop_origin: String,
        loop_quality: f64,
    ) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetDiagnostics {
            loop_origin,
            loop_quality,
            reply,
        })
    }

    pub fn status(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Status { reply })
    }

    pub(crate) fn sample_window(
        &self,
        center_frame: usize,
        radius_frames: usize,
        max_points: usize,
    ) -> Result<super::SampleWindow, String> {
        let guard = self.loaded_buffer.read().map_err(|e| e.to_string())?;
        let (_, _, buf) = guard.as_ref().ok_or("nothing loaded")?;
        let total = buf.frames();
        if total == 0 {
            return Err("track has no frames".to_string());
        }
        let channels = buf.channels.max(1) as usize;
        let lo = center_frame
            .saturating_sub(radius_frames)
            .min(total.saturating_sub(1));
        let hi = center_frame.saturating_add(radius_frames).min(total);
        let frame_count = hi.saturating_sub(lo);
        if frame_count == 0 {
            return Err("empty sample window".to_string());
        }
        // Downsample if frame_count exceeds max_points.
        let step = if frame_count > max_points {
            frame_count / max_points
        } else {
            1
        };
        let mut samples = Vec::with_capacity((frame_count / step).min(max_points));
        let mut frame = lo;
        while frame < hi && samples.len() < max_points {
            // Mix to mono.
            let mono: i16 = (0..channels)
                .map(|ch| buf.samples[frame * channels + ch] as i32)
                .sum::<i32>()
                .div_euclid(channels as i32) as i16;
            samples.push(mono);
            frame += step;
        }
        Ok(super::SampleWindow {
            start_frame: lo,
            end_frame: hi,
            sample_rate: buf.rate,
            channels: buf.channels,
            samples,
        })
    }

    pub(crate) fn snap_loop_boundary(
        &self,
        boundary: &str,
        requested_frame: usize,
        other_boundary_frame: usize,
    ) -> Result<super::SnappedBoundary, String> {
        let guard = self.loaded_buffer.read().map_err(|e| e.to_string())?;
        let (_, _, buf) = guard.as_ref().ok_or("nothing loaded")?;
        let total = buf.frames();
        if total == 0 {
            return Err("track has no frames".to_string());
        }
        let requested = requested_frame.min(total.saturating_sub(1));
        let snapped = snap_zero_crossing(buf, requested);
        // Compute discontinuity at the snapped boundary.
        let jump_amplitude = if snapped < total && requested < total {
            (buf.samples[snapped] as f64 - buf.samples[requested] as f64).abs()
        } else {
            0.0
        };
        let zero_crossing_found = snapped != requested
            || (snapped > 0
                && snapped < total
                && ((buf.samples[snapped - 1] as i32) * (buf.samples[snapped] as i32) <= 0));
        // Verify ordering after snap.
        let final_frame = match boundary {
            "start" => snapped.min(other_boundary_frame.saturating_sub(1)),
            "end" => snapped.max(other_boundary_frame + 1).min(total),
            _ => return Err("boundary must be \"start\" or \"end\"".to_string()),
        };
        let ms = if buf.rate > 0 {
            final_frame as u64 * 1000 / buf.rate as u64
        } else {
            0
        };
        Ok(super::SnappedBoundary {
            frame: final_frame,
            ms,
            discontinuity: jump_amplitude,
            zero_crossing_found,
        })
    }

    pub(crate) fn auto_loop(
        &self,
        bpm: Option<f64>,
    ) -> Result<crate::autoloop::AutoLoopResult, String> {
        let guard = self.loaded_buffer.read().map_err(|e| e.to_string())?;
        let (_, _, buf) = guard.as_ref().ok_or("nothing loaded")?;
        Ok(crate::autoloop::suggest(buf, bpm))
    }

    pub fn waveform_peaks(
        &self,
        path: &str,
        buckets: usize,
        cache_dir: &std::path::Path,
    ) -> Result<crate::waveform::WaveformData, String> {
        use crate::waveform::{cache_lookup, cache_store, clamp_buckets, from_buffer};
        let buckets = clamp_buckets(buckets);
        let req_path = std::path::Path::new(path);
        // Fast path: the persistent disk cache needs no engine lock at all,
        // so peak requests never contend with track loading or transport.
        let looked_up = std::time::Instant::now();
        if let Some(cached) = cache_lookup(cache_dir, req_path, buckets) {
            eprintln!(
                "[olooper:metrics] op=waveform result=hit lookup_ms={} buckets={} duration_ms={} path={path}",
                looked_up.elapsed().as_millis(),
                buckets,
                cached.duration_ms,
            );
            return Ok(cached);
        }
        let _compute = self
            .waveform_compute_lock
            .lock()
            .map_err(|e| e.to_string())?;
        // Another request may have populated the cache while this one waited.
        if let Some(cached) = cache_lookup(cache_dir, req_path, buckets) {
            return Ok(cached);
        }
        let lookup_ms = looked_up.elapsed().as_millis();
        // Cheap `Arc` clone under a short read lock; the heavy peak
        // computation below runs with no lock held.
        let snap_waited = std::time::Instant::now();
        let (snap_path, snap_gen, buffer) = {
            let guard = self.loaded_buffer.read().map_err(|e| e.to_string())?;
            let locked_ms = snap_waited.elapsed().as_millis();
            let (loaded_path, generation, buf) = guard.as_ref().ok_or("nothing loaded")?;
            if loaded_path != path {
                return Err("track changed before waveform analysis".to_string());
            }
            let snapshot = (loaded_path.clone(), *generation, buf.clone());
            eprintln!(
                "[olooper:metrics] op=waveform_lock stage=snapshot lock_wait_ms={locked_ms} path={path}",
            );
            snapshot
        };
        let computed = std::time::Instant::now();
        let waveform = from_buffer(&buffer, buckets);
        let compute_ms = computed.elapsed().as_millis();
        // Discard stale results: if the user selected another track (or
        // reloaded this one) while computing, the newer job owns the path.
        let rechecked = std::time::Instant::now();
        let current = self
            .loaded_buffer
            .read()
            .map_err(|e| e.to_string())
            .map(|guard| waveform_snapshot_current(&guard, &snap_path, snap_gen))
            .unwrap_or(false);
        let recheck_ms = rechecked.elapsed().as_millis();
        if !current {
            eprintln!(
                "[olooper:metrics] op=waveform result=stale compute_ms={compute_ms} buckets={buckets} path={path}",
            );
            return Err("track changed before waveform analysis".to_string());
        }
        let stored = std::time::Instant::now();
        cache_store(cache_dir, req_path, buckets, &waveform);
        eprintln!(
            "[olooper:metrics] op=waveform result=miss lookup_ms={lookup_ms} compute_ms={compute_ms} store_ms={} recheck_ms={recheck_ms} buckets={buckets} frames={} rate={} ch={} duration_ms={} path={path}",
            stored.elapsed().as_millis(),
            buffer.frames(),
            buffer.rate,
            buffer.channels,
            waveform.duration_ms,
        );
        Ok(waveform)
    }
}

/// Spawn the audio thread and return its client. Hardware-free until the
/// first `load`/`play`.
pub fn spawn() -> EngineClient {
    let (tx, rx) = std::sync::mpsc::channel();
    let loaded_buffer = std::sync::Arc::new(std::sync::RwLock::new(None));
    let waveform_compute_lock = std::sync::Arc::new(std::sync::Mutex::new(()));
    let engine_buffer = loaded_buffer.clone();
    let engine_tx = tx.clone();
    std::thread::Builder::new()
        .name("olooper-audio".to_string())
        .spawn(move || Engine::new(engine_buffer, engine_tx).run(rx))
        .expect("cannot spawn audio thread");
    EngineClient {
        tx,
        loaded_buffer,
        waveform_compute_lock,
    }
}

#[cfg(test)]
mod tests;
