//! Practice player: decode-on-load + gapless region looping.
//!
//! Timing lives here, never in the UI: the frontend only polls
//! [`PlayerStatus`]. Hardware (`OutputStream`) is created lazily so unit
//! tests run headless; all loop math is hardware-free.

use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source as _};
use serde::{Deserialize, Serialize};

/// Tracks longer than this are rejected (memory + practice-loop scope).
pub const MAX_DURATION_MS: u64 = 15 * 60 * 1000;
/// Inspection/read cap shared with the import pipeline.
const MAX_INPUT_LEN: u64 = 512 * 1024 * 1024;

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
    buf: Arc<LoopBuffer>,
    original_buf: Arc<LoopBuffer>,
    start_ms: u64,
    end_ms: u64,
    enabled: bool,
    resume_frame: usize,
    cursor: Arc<AtomicUsize>,
    volume: f32,
    speed: f32,
    pitch_lock: bool,
}

pub struct Player {
    handle: OutputStreamHandle,
    _stream: OutputStream,
    sink: Option<Sink>,
    track: Option<Loaded>,
}

impl Player {
    pub fn new() -> Result<Self, String> {
        let (_stream, handle) =
            OutputStream::try_default().map_err(|e| format!("no audio output: {e}"))?;
        Ok(Self {
            handle,
            _stream,
            sink: None,
            track: None,
        })
    }

    fn fresh_sink(&mut self, volume: f32) -> Result<Sink, String> {
        let sink = Sink::try_new(&self.handle).map_err(|e| format!("audio error: {e}"))?;
        sink.set_volume(volume);
        sink.pause();
        Ok(sink)
    }

    pub fn load(&mut self, path: String) -> Result<PlayerStatus, String> {
        let meta = std::fs::metadata(&path).map_err(|e| format!("cannot open file: {e}"))?;
        if meta.len() > MAX_INPUT_LEN {
            return Err("file exceeds the 512 MiB limit".to_string());
        }
        let data = std::fs::read(&path).map_err(|e| format!("cannot read file: {e}"))?;
        let buf = Arc::new(decode_owned(data)?);
        let duration_ms = buf.duration_ms();
        self.sink = None; // hard stop of previous audio
        let original_buf = buf.clone();
        self.track = Some(Loaded {
            path,
            buf,
            original_buf,
            start_ms: 0,
            end_ms: duration_ms,
            enabled: true,
            resume_frame: 0,
            cursor: Arc::new(AtomicUsize::new(0)),
            volume: self.track.as_ref().map(|t| t.volume).unwrap_or(0.8),
            speed: 1.0,
            pitch_lock: false,
        });
        Ok(self.status())
    }
}

fn region_frames(buf: &LoopBuffer, start_ms: u64, end_ms: u64) -> (usize, usize) {
    let total = buf.frames();
    let s = ms_to_frames(start_ms, buf.rate).min(total);
    let e = ms_to_frames(end_ms, buf.rate).clamp(1, total.max(1));
    (s.min(e.saturating_sub(1)), e)
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
        let (s, e) = region_frames(&t.buf, t.start_ms, t.end_ms);
        let volume = t.volume;
        let src = LoopRegion::new(
            t.buf.clone(),
            t.resume_frame,
            s,
            e,
            t.enabled,
            t.cursor.clone(),
        );
        let sink = self.fresh_sink(volume)?;
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
        let (s, _) = region_frames(&t.buf, t.start_ms, t.end_ms);
        self.sink = None; // drop first: no callback may advance the cursor after reset
        t.resume_frame = s; // spec: stop returns to loop start
        t.cursor.store(s, Ordering::Relaxed);
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
        let track = self.track.as_mut().ok_or("nothing loaded")?;
        track.speed = speed;
        if track.pitch_lock {
            track.buf = Arc::new(stretch_buffer(&track.original_buf, speed)?);
        }
        if let Some(sink) = &self.sink {
            sink.set_speed(if track.pitch_lock { 1.0 } else { speed });
        }
        Ok(self.status())
    }

    pub fn set_pitch_lock(&mut self, enabled: bool) -> Result<PlayerStatus, String> {
        let track = self.track.as_mut().ok_or("nothing loaded")?;
        track.pitch_lock = enabled;
        track.buf = if enabled && (track.speed - 1.0).abs() > f32::EPSILON {
            Arc::new(stretch_buffer(&track.original_buf, track.speed)?)
        } else {
            track.original_buf.clone()
        };
        if let Some(sink) = &self.sink {
            sink.set_speed(if enabled { 1.0 } else { track.speed });
        }
        Ok(self.status())
    }

    pub fn set_loop(&mut self, start_ms: u64, end_ms: u64) -> Result<PlayerStatus, String> {
        let t = self.track.as_mut().ok_or("nothing loaded")?;
        check_region(start_ms, end_ms, t.buf.duration_ms())?;
        t.start_ms = start_ms;
        t.end_ms = end_ms;
        let was_playing = self
            .sink
            .as_ref()
            .is_some_and(|s| !s.is_paused() && !s.empty());
        if was_playing {
            // Restart the region from the new start for sample-accurate behavior.
            let (s, e) = region_frames(&t.buf, t.start_ms, t.end_ms);
            t.resume_frame = s;
            let volume = t.volume;
            let src = LoopRegion::new(t.buf.clone(), s, s, e, t.enabled, t.cursor.clone());
            let sink = self.fresh_sink(volume)?;
            sink.append(src);
            sink.play();
            self.sink = Some(sink);
        } else {
            let (s, _) = region_frames(&t.buf, t.start_ms, t.end_ms);
            t.resume_frame = s;
            t.cursor.store(s, Ordering::Relaxed);
        }
        Ok(self.status())
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
        let (src, volume) = {
            let t = self.track.as_mut().ok_or("nothing loaded")?;
            t.enabled = enabled;
            // LoopRegion captures this flag when created, so rebuild the
            // source immediately instead of waiting for another transport action.
            let cursor = t.cursor.load(Ordering::Relaxed);
            let (start, end) = region_frames(&t.buf, t.start_ms, t.end_ms);
            t.resume_frame = cursor;
            (
                LoopRegion::new(t.buf.clone(), cursor, start, end, enabled, t.cursor.clone()),
                t.volume,
            )
        };
        let sink = self.fresh_sink(volume)?;
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
            let (s, e) = region_frames(&t.buf, t.start_ms, t.end_ms);
            let volume = t.volume;
            let enabled = t.enabled;
            let src = LoopRegion::new(t.buf.clone(), from, s, e, enabled, t.cursor.clone());
            let sink = self.fresh_sink(volume)?;
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
                PlayerStatus {
                    loaded: true,
                    path: Some(t.path.clone()),
                    playing,
                    position_ms: frames_to_ms(t.cursor.load(Ordering::Relaxed), t.buf.rate),
                    duration_ms: t.buf.duration_ms(),
                    loop_start_ms: t.start_ms,
                    loop_end_ms: t.end_ms,
                    loop_enabled: t.enabled,
                    volume_pct: t.volume * 100.0,
                    speed_pct: t.speed * 100.0,
                    pitch_lock: t.pitch_lock,
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
    pending_volume: f32,
    loaded_buffer: std::sync::Arc<std::sync::RwLock<Option<(String, Arc<LoopBuffer>)>>>,
}

type Reply = std::sync::mpsc::Sender<Result<PlayerStatus, String>>;

enum EngineCmd {
    Load {
        path: String,
        reply: Reply,
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
    SetLoop {
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
    Status {
        reply: Reply,
    },
}

impl Engine {
    pub fn new(
        loaded_buffer: std::sync::Arc<std::sync::RwLock<Option<(String, Arc<LoopBuffer>)>>>,
    ) -> Self {
        Self {
            player: None,
            pending_volume: 0.8,
            loaded_buffer,
        }
    }

    fn ensure(&mut self) -> Result<&mut Player, String> {
        if self.player.is_none() {
            self.player = Some(Player::new()?);
        }
        Ok(self.player.as_mut().expect("just created"))
    }

    fn status(&self) -> PlayerStatus {
        self.player.as_ref().map_or_else(
            || PlayerStatus {
                volume_pct: self.pending_volume * 100.0,
                ..PlayerStatus::empty()
            },
            |p| p.status(),
        )
    }

    fn run(mut self, rx: std::sync::mpsc::Receiver<EngineCmd>) {
        while let Ok(cmd) = rx.recv() {
            let (out, reply) = match cmd {
                EngineCmd::Load { path, reply } => (self.cmd_load(path), reply),
                EngineCmd::Play { reply } => (self.ensure().and_then(|p| p.play()), reply),
                EngineCmd::Pause { reply } => (self.ensure().and_then(|p| p.pause()), reply),
                EngineCmd::Stop { reply } => (self.ensure().and_then(|p| p.stop()), reply),
                EngineCmd::SetVolume { volume_pct, reply } => (self.cmd_volume(volume_pct), reply),
                EngineCmd::SetSpeed { speed_pct, reply } => (self.ensure().and_then(|p| p.set_speed(speed_pct)), reply),
                EngineCmd::SetPitchLock { enabled, reply } => (self.ensure().and_then(|p| p.set_pitch_lock(enabled)), reply),
                EngineCmd::SetLoop {
                    start_ms,
                    end_ms,
                    reply,
                } => (
                    self.ensure().and_then(|p| p.set_loop(start_ms, end_ms)),
                    reply,
                ),
                EngineCmd::SetLoopEnabled { enabled, reply } => (
                    self.ensure().and_then(|p| p.set_loop_enabled(enabled)),
                    reply,
                ),
                EngineCmd::Seek { position_ms, reply } => {
                    (self.ensure().and_then(|p| p.seek(position_ms)), reply)
                }
                EngineCmd::Status { reply } => (Ok(self.status()), reply),
            };
            let _ = reply.send(out);
        }
    }

    fn cmd_load(&mut self, path: String) -> Result<PlayerStatus, String> {
        let vol = self.pending_volume;
        let (status, loaded) = {
            let p = self.ensure()?;
            p.load(path)?;
            if let Some(t) = &mut p.track {
                t.volume = vol;
                if let Some(s) = &p.sink {
                    s.set_volume(vol);
                }
            }
            (
                p.status(),
                p.track
                    .as_ref()
                    .map(|track| (track.path.clone(), track.buf.clone())),
            )
        };
        *self.loaded_buffer.write().map_err(|e| e.to_string())? = loaded;
        Ok(status)
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
        Self::new(std::sync::Arc::new(std::sync::RwLock::new(None)))
    }
}

#[derive(Debug, Clone)]
pub struct EngineClient {
    tx: std::sync::mpsc::Sender<EngineCmd>,
    loaded_buffer: std::sync::Arc<std::sync::RwLock<Option<(String, Arc<LoopBuffer>)>>>,
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

    pub fn set_loop_enabled(&self, enabled: bool) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::SetLoopEnabled { enabled, reply })
    }

    pub fn seek(&self, position_ms: u64) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Seek { position_ms, reply })
    }

    pub fn status(&self) -> Result<PlayerStatus, String> {
        self.call(|reply| EngineCmd::Status { reply })
    }

    pub fn waveform_peaks(
        &self,
        path: &str,
        buckets: usize,
        cache_dir: &std::path::Path,
    ) -> Result<crate::waveform::WaveformData, String> {
        let guard = self.loaded_buffer.read().map_err(|e| e.to_string())?;
        let (loaded_path, buffer) = guard.as_ref().ok_or("nothing loaded")?;
        if loaded_path != path {
            return Err("track changed before waveform analysis".to_string());
        }
        crate::waveform::cached_from_buffer(cache_dir, std::path::Path::new(path), buckets, buffer)
    }
}

/// Spawn the audio thread and return its client. Hardware-free until the
/// first `load`/`play`.
pub fn spawn() -> EngineClient {
    let (tx, rx) = std::sync::mpsc::channel();
    let loaded_buffer = std::sync::Arc::new(std::sync::RwLock::new(None));
    let engine_buffer = loaded_buffer.clone();
    std::thread::Builder::new()
        .name("olooper-audio".to_string())
        .spawn(move || Engine::new(engine_buffer).run(rx))
        .expect("cannot spawn audio thread");
    EngineClient { tx, loaded_buffer }
}

#[cfg(test)]
mod tests;
