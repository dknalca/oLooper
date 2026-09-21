//! Practice player: decode-on-load + gapless region looping.
//!
//! Timing lives here, never in the UI: the frontend only polls
//! [`PlayerStatus`]. Hardware (`OutputStream`) is created lazily so unit
//! tests run headless; all loop math is hardware-free.

use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::collections::VecDeque;

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source as _};
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

    fn memory_bytes(&self) -> usize { self.samples.len() * std::mem::size_of::<i16>() }
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
    /// Sample index into `buf.samples`.
    idx: usize,
    start_frame: usize,
    end_frame: usize,
    enabled: bool,
    /// Current frame, mirrored for UI polling.
    cursor: Arc<AtomicUsize>,
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
        let ch = buf.channels.max(1) as usize;
        let from = from_frame.clamp(start_frame.min(end_frame), end_frame.max(start_frame));
        let s = Self {
            buf,
            idx: from * ch,
            start_frame,
            end_frame,
            enabled,
            cursor,
        };
        s.cursor.store(from, Ordering::Relaxed);
        s
    }
}

impl Iterator for LoopRegion {
    type Item = i16;

    fn next(&mut self) -> Option<i16> {
        let ch = self.buf.channels.max(1) as usize;
        let mut frame = self.idx / ch;
        if self.enabled {
            if frame >= self.end_frame {
                frame = self.start_frame;
                self.idx = frame * ch;
            }
        } else if frame >= self.end_frame {
            return None;
        }
        let s = *self.buf.samples.get(self.idx)?;
        if self.idx % ch == 0 {
            self.cursor.store(frame, Ordering::Relaxed);
        }
        self.idx += 1;
        Some(s)
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

/// Decode any rodio-supported bytes into a buffer. Hardware-free.
pub fn decode_bytes(data: &[u8]) -> Result<LoopBuffer, String> {
    decode_owned(data.to_vec())
}

fn decode_owned(data: Vec<u8>) -> Result<LoopBuffer, String> {
    let dec = Decoder::new(Cursor::new(data)).map_err(|e| format!("cannot decode audio: {e}"))?;
    let (channels, rate) = (dec.channels(), dec.sample_rate());
    if channels == 0 || rate == 0 {
        return Err("decoded stream has no channels or rate".to_string());
    }
    let samples: Vec<i16> = dec.collect();
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

/// What background readers observe: (path, load generation, decoded audio).
/// Cloned as a cheap `Arc` under a short lock; never held during computation.
type LoadedSnapshot = Option<(String, u64, Arc<LoopBuffer>)>;

/// A waveform job is current only if the live snapshot still matches the
/// (path, generation) it started from. Same path but newer generation
/// (reloaded track) also discards: the newer job owns that path now.
fn waveform_snapshot_current(
    loaded: &LoadedSnapshot,
    path: &str,
    generation: u64,
) -> bool {
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
        && (track.speed - speed).abs() <= f32::EPSILON
}

/// A load completion applies only if it is still the latest request.
fn load_ready_current(
    pending: &Option<PendingLoad>,
    generation: u64,
    path: &str,
) -> bool {
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

#[derive(Clone)]
struct PendingLoad {
    generation: u64,
    path: String,
}

pub struct Player {
    handle: OutputStreamHandle,
    _stream: OutputStream,
    sink: Option<Sink>,
    track: Option<Loaded>,
    /// Channel back to the engine loop, so background workers (decode,
    /// WSOLA) can post completions to be applied on the audio thread.
    tx: std::sync::mpsc::Sender<EngineCmd>,
    pitch_seq: u64,
}

impl Player {
    pub(crate) fn new(tx: std::sync::mpsc::Sender<EngineCmd>) -> Result<Self, String> {
        let (_stream, handle) =
            OutputStream::try_default().map_err(|e| format!("no audio output: {e}"))?;
        Ok(Self {
            handle,
            _stream,
            sink: None,
            track: None,
            tx,
            pitch_seq: 0,
        })
    }

    fn fresh_sink(&mut self, volume: f32, speed: f32) -> Result<Sink, String> {
        let sink = Sink::try_new(&self.handle).map_err(|e| format!("audio error: {e}"))?;
        sink.set_volume(volume);
        sink.set_speed(speed);
        sink.pause();
        Ok(sink)
    }
}

/// Find the closest zero crossing in a 10 ms window without changing PCM.
/// For stereo, searches on mono but penalizes candidates where any channel
/// has high discontinuity.
fn snap_zero_crossing(buf: &LoopBuffer, requested: usize) -> usize {
    let frames = buf.frames();
    if frames < 2 { return requested.min(frames); }
    let radius = (buf.rate as usize / 100).max(1);
    let lo = requested.saturating_sub(radius).min(frames - 1);
    let hi = requested.saturating_add(radius).min(frames - 1);
    let channels = buf.channels.max(1) as usize;
    let mono = |frame: usize| (0..channels).map(|channel| buf.samples.get(frame * channels + channel).copied().unwrap_or(0) as i32).sum::<i32>() / channels as i32;
    // For stereo, compute per-channel discontinuity at a candidate.
    let channel_discontinuity = |frame: usize| {
        (0..channels).map(|ch| {
            let a = buf.samples.get(frame * channels + ch).copied().unwrap_or(0) as i32;
            let b = buf.samples.get((frame + 1) * channels + ch).copied().unwrap_or(0) as i32;
            (a - b).unsigned_abs()
        }).max().unwrap_or(0)
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
        (lo..=hi).min_by_key(|frame| mono(*frame).unsigned_abs()).unwrap_or(requested.min(frames))
    })
}

fn stretch_buffer(buffer: &LoopBuffer, tempo: f32) -> Result<LoopBuffer, String> {
    let samples: Vec<f32> = buffer.samples.iter().map(|sample| *sample as f32 / 32768.0).collect();
    let stretched = wsola::stretch(&samples, buffer.rate, buffer.channels, tempo)
        .map_err(|error| format!("cannot preserve pitch: {error}"))?;
    Ok(LoopBuffer {
        samples: stretched.into_iter().map(|sample| (sample.clamp(-1.0, 1.0) * 32767.0) as i16).collect(),
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
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| stretch_buffer(buffer, tempo)))
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
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decode_owned(data)))
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
        let src = LoopRegion::new(
            t.buf.clone(),
            t.resume_frame,
            t.start_frame,
            t.end_frame,
            t.enabled,
            t.cursor.clone(),
        );
        let sink = self.fresh_sink(volume, speed)?;
        sink.append(src);
        sink.play();
        self.sink = Some(sink);
        Ok(self.status())
    }

    pub fn pause(&mut self) -> Result<PlayerStatus, String> {
        let (sink, t) = self
            .sink
            .as_ref()
            .zip(self.track.as_mut())
            .ok_or("nothing playing")?;
        t.resume_frame = t.cursor.load(Ordering::Relaxed);
        sink.pause();
        Ok(self.status())
    }

    pub fn stop(&mut self) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        self.sink = None; // drop first: no callback may advance the cursor after reset
        t.resume_frame = t.start_frame; // spec: stop returns to loop start
        t.cursor.store(t.start_frame, Ordering::Relaxed);
        Ok(self.status())
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
            track.pitch_lock
        };
        if locked {
            // New speed supersedes any in-flight stretch; current audio
            // keeps playing untouched until the new buffer is ready.
            self.request_stretch();
        } else if let Some(sink) = &self.sink {
            sink.set_speed(speed);
        }
        Ok(self.status())
    }

    pub fn set_pitch_lock(&mut self, enabled: bool) -> Result<PlayerStatus, String> {
        if !enabled {
            // Cancel: invalidate any in-flight job, restore the original
            // buffer, keep playback position.
            let seq = self.pitch_seq + 1;
            self.pitch_seq = seq;
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.pitch_lock = false;
            track.pitch_pending = false;
            track.pitch_job = seq;
            track.pitch_error = None;
            track.buf = track.original_buf.clone();
            let speed = track.speed;
            if let Some(sink) = &self.sink {
                sink.set_speed(speed);
            }
            return Ok(self.status());
        }
        let needs_stretch = {
            let track = self.track.as_mut().ok_or("nothing loaded")?;
            track.pitch_lock = true;
            track.pitch_error = None;
            if (track.speed - 1.0).abs() <= f32::EPSILON {
                // No stretch needed at 100%: apply immediately, no worker.
                track.pitch_pending = false;
                track.buf = track.original_buf.clone();
                if let Some(sink) = &self.sink {
                    sink.set_speed(1.0);
                }
                false
            } else {
                true
            }
        };
        if needs_stretch {
            self.request_stretch();
        }
        Ok(self.status())
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
        if was_playing {
            // Restart the region from the new start for sample-accurate behavior.
            t.resume_frame = t.start_frame;
            let volume = t.volume;
            let speed = if t.pitch_lock { 1.0 } else { t.speed };
            let src = LoopRegion::new(t.buf.clone(), t.start_frame, t.start_frame, t.end_frame, t.enabled, t.cursor.clone());
            let sink = self.fresh_sink(volume, speed)?;
            sink.append(src);
            sink.play();
            self.sink = Some(sink);
        } else {
            t.resume_frame = t.start_frame;
            t.cursor.store(t.start_frame, Ordering::Relaxed);
        }
        Ok(self.status())
    }

    /// Set loop directly with frame-precise values (no ms conversion).
    pub fn set_loop_frames(&mut self, start_frame: usize, end_frame: usize) -> Result<PlayerStatus, String> {
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
        if was_playing {
            t.resume_frame = t.start_frame;
            let volume = t.volume;
            let speed = if t.pitch_lock { 1.0 } else { t.speed };
            let src = LoopRegion::new(t.buf.clone(), t.start_frame, t.start_frame, t.end_frame, t.enabled, t.cursor.clone());
            let sink = self.fresh_sink(volume, speed)?;
            sink.append(src);
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
        if start >= end { return Err("snapped loop start must be before end".to_string()); }
        let _ = track;
        self.set_loop_frames(start, end)
    }

    pub fn set_loop_enabled(&mut self, enabled: bool) -> Result<PlayerStatus, String> {
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        if !was_playing {
            self.track.as_mut().ok_or("nothing loaded")?.enabled = enabled;
            return Ok(self.status());
        }
        let (src, volume, speed) = {
            let t = self.track.as_mut().ok_or("nothing loaded")?;
            t.enabled = enabled;
            // LoopRegion captures this flag when created, so rebuild the
            // source immediately instead of waiting for another transport action.
            let cursor = t.cursor.load(Ordering::Relaxed);
            t.resume_frame = cursor;
            (
                LoopRegion::new(t.buf.clone(), cursor, t.start_frame, t.end_frame, enabled, t.cursor.clone()),
                t.volume,
                if t.pitch_lock { 1.0 } else { t.speed },
            )
        };
        let sink = self.fresh_sink(volume, speed)?;
        sink.append(src);
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
            let src = LoopRegion::new(t.buf.clone(), from, t.start_frame, t.end_frame, enabled, t.cursor.clone());
            let sink = self.fresh_sink(volume, speed)?;
            sink.append(src);
            sink.play();
            self.sink = Some(sink);
        }
        Ok(self.status())
    }

    pub fn status(&self) -> PlayerStatus {
        match &self.track {
            None => PlayerStatus::empty(),
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
    decoded_cache: VecDeque<(String, Arc<LoopBuffer>)>,
    decoded_cache_bytes: usize,
}

type Reply = std::sync::mpsc::Sender<Result<PlayerStatus, String>>;

/// Internal commands. `pub(crate)` only because the type appears in
/// `pub(crate)` constructors; never sent across the Tauri boundary.
pub(crate) enum EngineCmd {
    Load {
        path: String,
        reply: Reply,
    },
    /// Posted by the decode worker. Applied only if still the latest load.
    LoadReady {
        generation: u64,
        path: String,
        result: Result<LoopBuffer, String>,
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
    SetVolume {
        volume_pct: f32,
        reply: Reply,
    },
    SetSpeed { speed_pct: f32, reply: Reply },
    SetPitchLock { enabled: bool, reply: Reply },
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
    SetLoopSnapped { start_ms: u64, end_ms: u64, reply: Reply },
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
            self.player = Some(Player::new(tx)?);
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
        while let Ok(cmd) = rx.recv() {
            match cmd {
                // Worker completions carry no reply: they were requested
                // by an earlier command whose reply already went out.
                EngineCmd::LoadReady {
                    generation,
                    path,
                    result,
                } => self.cmd_load_ready(generation, path, result),
                EngineCmd::PitchReady {
                    track_generation,
                    job,
                    speed,
                    result,
                } => self.cmd_pitch_ready(track_generation, job, speed, result),
                EngineCmd::Load { path, reply } => {
                    let _ = reply.send(self.cmd_load(path));
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
                EngineCmd::SetVolume { volume_pct, reply } => {
                    let _ = reply.send(self.cmd_volume(volume_pct));
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
                EngineCmd::SetLoopSnapped { start_ms, end_ms, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_loop_snapped(start_ms, end_ms)));
                }
                EngineCmd::SetLoopEnabled { enabled, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.set_loop_enabled(enabled)));
                }
                EngineCmd::Seek { position_ms, reply } => {
                    let _ = reply.send(self.ensure().and_then(|p| p.seek(position_ms)));
                }
                EngineCmd::SetDiagnostics { loop_origin, loop_quality, reply } => {
                    if let Some(p) = self.player.as_mut() {
                        if let Some(t) = p.track.as_mut() {
                            t.loop_origin = loop_origin;
                            t.loop_quality = loop_quality;
                        }
                    }
                    let _ = reply.send(Ok(self.status()));
                }
                EngineCmd::Status { reply } => {
                    let _ = reply.send(Ok(self.status()));
                }
            }
        }
    }

    /// Start a background decode and return a loading status instantly.
    /// Previous audio keeps playing until a valid buffer arrives.
    fn cmd_load(&mut self, path: String) -> Result<PlayerStatus, String> {
        self.generation += 1;
        let generation = self.generation;
        if let Some(index) = self.decoded_cache.iter().position(|(cached, _)| cached == &path) {
            let (_, buffer) = self.decoded_cache.remove(index).expect("cache index exists");
            self.decoded_cache_bytes = self.decoded_cache_bytes.saturating_sub(buffer.memory_bytes());
            self.apply_loaded(path, generation, buffer);
            return Ok(self.status());
        }
        self.pending_load = Some(PendingLoad {
            generation,
            path: path.clone(),
        });
        self.last_load_error = None;
        if self.decode_running {
            return Ok(self.status());
        }
        self.start_pending_decode();
        Ok(self.status())
    }

    fn start_pending_decode(&mut self) {
        let Some(pending) = self.pending_load.clone() else { return; };
        self.decode_running = true;
        let tx = self.tx.clone();
        if std::thread::Builder::new()
            .name("olooper-decode".to_string())
            .spawn(move || {
                let result = read_and_decode(&pending.path);
                let _ = tx.send(EngineCmd::LoadReady {
                    generation: pending.generation,
                    path: pending.path,
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
        let buf = match result {
            Err(e) => {
                self.last_load_error = Some(e);
                return;
            }
            Ok(buf) => buf,
        };
        self.apply_loaded(path, generation, Arc::new(buf));
    }

    fn apply_loaded(&mut self, path: String, generation: u64, buf: Arc<LoopBuffer>) {
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
                self.cache_decoded(snapshot.0.clone(), snapshot.2.clone());
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

    fn cache_decoded(&mut self, path: String, buffer: Arc<LoopBuffer>) {
        self.decoded_cache.retain(|(cached, _)| cached != &path);
        self.decoded_cache_bytes = self.decoded_cache.iter().map(|(_, cached)| cached.memory_bytes()).sum();
        let bytes = buffer.memory_bytes();
        if bytes > DECODE_CACHE_MAX_BYTES { return; }
        while self.decoded_cache.len() >= DECODE_CACHE_MAX_TRACKS
            || self.decoded_cache_bytes.saturating_add(bytes) > DECODE_CACHE_MAX_BYTES {
            let Some((_, evicted)) = self.decoded_cache.pop_front() else { break; };
            self.decoded_cache_bytes = self.decoded_cache_bytes.saturating_sub(evicted.memory_bytes());
        }
        self.decoded_cache_bytes += bytes;
        self.decoded_cache.push_back((path, buffer));
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
        if (t.pitch_requested_speed - speed).abs() > f32::EPSILON {
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
                let new_end = remap_frame(t.end_frame, old_frames, new_frames).max(1).min(new_frames);
                // Keep the listening position across the buffer swap.
                let resume_frame = remap_frame(t.resume_frame, old_frames, new_frames);
                let from = remap_frame(t.cursor.load(Ordering::Relaxed), old_frames, new_frames);
                let (cursor, volume, enabled) = (
                    t.cursor.clone(),
                    t.volume,
                    t.enabled,
                );
                let was_playing = p
                    .sink
                    .as_ref()
                    .is_some_and(|s| !s.is_paused() && !s.empty());
                if was_playing {
                    // Restart on the stretched buffer at locked (1.0x) rate.
                    let src = LoopRegion::new(new_buf.clone(), from, new_start, new_end, enabled, cursor);
                    let sink = match Sink::try_new(&p.handle) {
                        Ok(sink) => { sink.set_volume(volume); sink.set_speed(1.0); sink.pause(); sink },
                        Err(error) => { t.pitch_pending = false; t.pitch_error = Some(error.to_string()); return; }
                    };
                    sink.append(src);
                    sink.play();
                    p.sink = Some(sink);
                }
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
        rx.recv().map_err(|_| "audio engine stopped".to_string())?
    }

    pub fn load(&self, path: String) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Load { path, reply })
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

    pub fn set_volume(&self, volume_pct: f32) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetVolume { volume_pct, reply })
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
        self.call(|reply| EngineCmd::SetLoopSnapped { start_ms, end_ms, reply })
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
        self.call(|reply| EngineCmd::SetDiagnostics { loop_origin, loop_quality, reply })
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
        let lo = center_frame.saturating_sub(radius_frames).min(total.saturating_sub(1));
        let hi = center_frame.saturating_add(radius_frames).min(total);
        let frame_count = hi.saturating_sub(lo);
        if frame_count == 0 {
            return Err("empty sample window".to_string());
        }
        // Downsample if frame_count exceeds max_points.
        let step = if frame_count > max_points { frame_count / max_points } else { 1 };
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
            || (snapped > 0 && snapped < total
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
        let _compute = self.waveform_compute_lock.lock().map_err(|e| e.to_string())?;
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
    EngineClient { tx, loaded_buffer, waveform_compute_lock }
}

#[cfg(test)]
mod tests;
