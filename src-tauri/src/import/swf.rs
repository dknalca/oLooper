//! SWF container parsing + `DefineSound` MP3 extraction.
//!
//! Supports `FWS` (raw) and `CWS` (zlib) containers. `ZWS` (LZMA) is reported
//! as unsupported, never guessed. All reads are bounds-checked; allocations
//! are capped by the header-declared length.

use std::fmt;
use std::io::Read as _;

/// Hard cap for any SWF-declared length (256 MiB). Above this we reject
/// instead of allocating on a file-controlled size.
pub const MAX_SWF_LEN: u32 = 256 * 1024 * 1024;

/// `DefineSound` tag id.
const TAG_DEFINE_SOUND: u16 = 14;
const TAG_SOUND_STREAM_HEAD: u16 = 18;
const TAG_SOUND_STREAM_BLOCK: u16 = 19;
const TAG_SOUND_STREAM_HEAD2: u16 = 45;
/// `DefineSound` format id for MP3.
pub const FORMAT_MP3: u8 = 2;
pub const FORMAT_ADPCM: u8 = 1;
/// Highest SWF version we accept.
pub(crate) const MAX_VERSION: u8 = 40;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwfError {
    TooSmall,
    BadMagic([u8; 3]),
    UnsupportedCompression(&'static str),
    VersionTooNew(u8),
    DeclaredTooLarge(u32),
    Truncated { declared: u32, actual: usize },
    LengthMismatch { declared: u32, actual: usize },
    Decompress(String),
    BadRect,
    TagOverrun,
}

impl fmt::Display for SwfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooSmall => write!(f, "file too small to be a SWF"),
            Self::BadMagic(m) => write!(f, "not a SWF file (magic {m:02X?})"),
            Self::UnsupportedCompression(c) => {
                write!(f, "SWF compression '{c}' is not supported yet")
            }
            Self::VersionTooNew(v) => write!(f, "SWF version {v} is newer than supported"),
            Self::DeclaredTooLarge(n) => {
                write!(f, "SWF declares {n} bytes, above the safety limit")
            }
            Self::Truncated { declared, actual } => write!(
                f,
                "SWF truncated: declares {declared} bytes but file has {actual}"
            ),
            Self::LengthMismatch { declared, actual } => write!(
                f,
                "SWF body length mismatch: declares {declared} bytes, got {actual}"
            ),
            Self::Decompress(e) => write!(f, "SWF decompression failed: {e}"),
            Self::BadRect => write!(f, "SWF frame-size record is malformed"),
            Self::TagOverrun => write!(f, "SWF tag overruns the file"),
        }
    }
}

impl std::error::Error for SwfError {}

/// User-facing message: what failed + source intact + next action.
pub fn user_message(e: &SwfError) -> String {
    format!("{e}. The original file was not modified. Try another file or report it.")
}

/// One extracted sound in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sound {
    pub id: u16,
    pub format: u8,
    /// Container produced for the library. ADPCM is decoded to WAV; MP3 stays raw.
    pub codec: String,
    /// Raw sample count from `DefineSound`.
    pub sample_count: u32,
    /// MP3 `SeekSamples` prefix (not audio); frames exclude it.
    pub seek_samples: u16,
    /// Leading non-frame bytes stripped before the first frame
    /// (e.g. zero padding some authoring tools prepend). Frames are
    /// preserved byte-identical; stripping is de-containering, not transcoding.
    pub trimmed_leading: usize,
    /// Audio payload bytes (MP3 frames for format 2), preserved as-is.
    pub frames: Vec<u8>,
}

/// A `DefineSound` we deliberately did not extract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSound {
    pub id: u16,
    pub format: u8,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwfSounds {
    pub version: u8,
    pub sounds: Vec<Sound>,
    pub skipped: Vec<SkippedSound>,
}

struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, bit: 0 }
    }

    fn read_bits(&mut self, n: usize) -> Result<u32, SwfError> {
        let mut out: u32 = 0;
        for _ in 0..n {
            let byte = *self.data.get(self.bit / 8).ok_or(SwfError::BadRect)?;
            let b = (byte >> (7 - (self.bit % 8))) & 1;
            out = (out << 1) | u32::from(b);
            self.bit += 1;
        }
        Ok(out)
    }

    fn read_signed(&mut self, n: usize) -> Result<i32, SwfError> {
        let value = self.read_bits(n)? as i32;
        Ok(if value & (1 << (n - 1)) != 0 {
            value - (1 << n)
        } else {
            value
        })
    }
}

/// Byte length of the RECT starting at `body[0]` (frame size record).
fn rect_len(body: &[u8]) -> Result<usize, SwfError> {
    let mut r = BitReader::new(body);
    let nbits = r.read_bits(5)? as usize;
    if nbits > 32 {
        return Err(SwfError::BadRect);
    }
    for _ in 0..4 {
        r.read_bits(nbits)?;
    }
    Ok(r.bit.div_ceil(8))
}

fn u16le_at(data: &[u8], off: usize) -> Result<u16, SwfError> {
    data.get(off..off + 2)
        .and_then(|b| b.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or(SwfError::TagOverrun)
}

fn u32le_at(data: &[u8], off: usize) -> Result<u32, SwfError> {
    data.get(off..off + 4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(SwfError::TagOverrun)
}

/// Decompress the body; returns owned bytes so FWS/CWS share one code path.
fn body_bytes(data: &[u8]) -> Result<(u8, Vec<u8>), SwfError> {
    if data.len() < 8 {
        return Err(SwfError::TooSmall);
    }
    let magic: [u8; 3] = [data[0], data[1], data[2]];
    let version = data[3];
    let declared = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);

    if version == 0 || version > MAX_VERSION {
        return Err(SwfError::VersionTooNew(version));
    }
    if declared > MAX_SWF_LEN {
        return Err(SwfError::DeclaredTooLarge(declared));
    }
    match &magic {
        b"FWS" => {
            if data.len() < declared as usize {
                return Err(SwfError::Truncated {
                    declared,
                    actual: data.len(),
                });
            }
            Ok((version, data[8..declared as usize].to_vec()))
        }
        b"CWS" => {
            // The header length is for the decompressed FWS image. A valid
            // compressed stream is normally much smaller, so do not compare
            // the on-disk length with `declared` before decompression.
            let expected = declared as usize - 8;
            let dec = flate2::read::ZlibDecoder::new(&data[8..]);
            let mut out = Vec::new();
            dec.take((expected + 1) as u64)
                .read_to_end(&mut out)
                .map_err(|e| SwfError::Decompress(e.to_string()))?;
            if out.len() != expected {
                return Err(SwfError::LengthMismatch {
                    declared,
                    actual: out.len() + 8,
                });
            }
            Ok((version, out))
        }
        b"ZWS" => Err(SwfError::UnsupportedCompression("ZWS/LZMA")),
        _ => Err(SwfError::BadMagic(magic)),
    }
}

/// Offset of the first plausible MPEG frame header, or `None`.
///
/// Validates the 4-byte header (sync, version/layer reserved values excluded,
/// bitrate and sample-rate indices valid) to avoid false positives inside
/// audio data.
fn mp3_frame_start(data: &[u8]) -> Option<usize> {
    if data.len() < 4 {
        return None;
    }
    for i in 0..data.len() - 3 {
        let b = &data[i..i + 4];
        if b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
            continue;
        }
        let version = (b[1] >> 3) & 0x03;
        let layer = (b[1] >> 1) & 0x03;
        let bitrate = (b[2] >> 4) & 0x0F;
        let freq = (b[2] >> 2) & 0x03;
        if version == 1 || layer == 0 || bitrate == 0 || bitrate == 15 || freq == 3 {
            continue;
        }
        return Some(i);
    }
    None
}

fn wav_from_adpcm(payload: &[u8], flags: u8, sample_count: u32) -> Option<Vec<u8>> {
    if payload.is_empty() || sample_count == 0 || sample_count > 15 * 60 * 44_100 {
        return None;
    }
    let rate = match (flags >> 2) & 0x03 {
        0 => 5_512,
        1 => 11_025,
        2 => 22_050,
        _ => 44_100,
    };
    let channels = if flags & 0x01 != 0 { 2usize } else { 1usize };
    let mut bits = BitReader::new(payload);
    let code_bits = bits.read_bits(2).ok()? as usize + 2;
    let steps: [i32; 89] = [
        7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60,
        66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
        408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
        2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
        8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
        29794, 32767,
    ];
    let index_adjust: &[i32] = match code_bits {
        2 => &[-1, 2],
        3 => &[-1, -1, 2, 4],
        4 => &[-1, -1, -1, -1, 2, 4, 6, 8],
        5 => &[-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16],
        _ => return None,
    };
    let mut sample = Vec::with_capacity(channels);
    let mut index = Vec::with_capacity(channels);
    let total = sample_count as usize;
    let mut pcm = Vec::with_capacity(total.checked_mul(channels)?.checked_mul(2)?);
    for frame in 0..total {
        // Flash ADPCM stores a fresh predictor and step index every 4095
        // samples. ADPCMCodeSize is only present once at the stream start.
        if frame % 4095 == 0 {
            sample.clear();
            index.clear();
            for _ in 0..channels {
                sample.push(bits.read_signed(16).ok()?);
                index.push(bits.read_bits(6).ok()?.min(88) as usize);
            }
        }
        for channel in 0..channels {
            if frame % 4095 != 0 {
                let code = bits.read_bits(code_bits).ok()? as usize;
                let step = steps[index[channel]];
                let mut diff = step >> (code_bits - 1);
                for bit in 0..code_bits - 1 {
                    if code & (1 << bit) != 0 {
                        diff += step >> (code_bits - 2 - bit);
                    }
                }
                if code & (1 << (code_bits - 1)) != 0 {
                    sample[channel] -= diff;
                } else {
                    sample[channel] += diff;
                }
                sample[channel] = sample[channel].clamp(i16::MIN as i32, i16::MAX as i32);
                index[channel] = (index[channel] as i32
                    + index_adjust[code & (index_adjust.len() - 1)])
                    .clamp(0, 88) as usize;
            }
            pcm.extend_from_slice(&(sample[channel] as i16).to_le_bytes());
        }
    }
    let byte_rate = rate * channels as u32 * 2;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&(channels as u16).to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&((channels * 2) as u16).to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(&pcm);
    Some(wav)
}

fn parse_define_sound(tag: &[u8]) -> Result<Sound, SkippedSound> {
    let bad = |reason: &'static str| SkippedSound {
        id: tag.first().copied().unwrap_or(0) as u16
            | ((tag.get(1).copied().unwrap_or(0) as u16) << 8),
        format: tag.get(2).copied().unwrap_or(0) >> 4,
        reason,
    };
    if tag.len() < 7 {
        return Err(bad("tag too short"));
    }
    let id = u16::from_le_bytes([tag[0], tag[1]]);
    let format = tag[2] >> 4;
    let sample_count = u32::from_le_bytes([tag[3], tag[4], tag[5], tag[6]]);
    if format != FORMAT_MP3 && format != FORMAT_ADPCM {
        return Err(SkippedSound {
            id,
            format,
            reason: "non-MP3 sound codec not supported yet",
        });
    }
    if format == FORMAT_ADPCM {
        let Some(frames) = wav_from_adpcm(&tag[7..], tag[2], sample_count) else {
            return Err(SkippedSound {
                id,
                format,
                reason: "malformed or oversized ADPCM sound",
            });
        };
        return Ok(Sound {
            id,
            format,
            codec: "wav".to_string(),
            sample_count,
            seek_samples: 0,
            trimmed_leading: 0,
            frames,
        });
    }
    if tag.len() < 9 {
        return Err(SkippedSound {
            id,
            format,
            reason: "MP3 sound has no audio data",
        });
    }
    let payload = &tag[9..];
    let Some(start) = mp3_frame_start(payload) else {
        return Err(SkippedSound {
            id,
            format,
            reason: "MP3 sound contains no frame sync",
        });
    };
    Ok(Sound {
        id,
        format,
        codec: "mp3".to_string(),
        sample_count,
        seek_samples: u16::from_le_bytes([tag[7], tag[8]]),
        trimmed_leading: start,
        frames: payload[start..].to_vec(),
    })
}

struct StreamSound {
    id: u16,
    sample_count: u32,
    seek_samples: u16,
    frames: Vec<u8>,
}

fn finish_stream(stream: StreamSound, sounds: &mut Vec<Sound>, skipped: &mut Vec<SkippedSound>) {
    if stream.frames.is_empty() {
        skipped.push(SkippedSound {
            id: stream.id,
            format: FORMAT_MP3,
            reason: "MP3 stream contains no frame sync",
        });
        return;
    }
    sounds.push(Sound {
        id: stream.id,
        format: FORMAT_MP3,
        codec: "mp3".to_string(),
        sample_count: stream.sample_count,
        seek_samples: stream.seek_samples,
        trimmed_leading: 0,
        frames: stream.frames,
    });
}

/// Parse a SWF file image, extracting MP3 `DefineSound`s in file order.
pub fn parse(data: &[u8]) -> Result<SwfSounds, SwfError> {
    let (version, body) = body_bytes(data)?;

    // Skip FrameSize RECT + FrameRate (2) + FrameCount (2).
    let mut off = rect_len(&body)?;
    off = off
        .checked_add(4)
        .filter(|&o| o <= body.len())
        .ok_or(SwfError::TagOverrun)?;

    let mut sounds = Vec::new();
    let mut skipped = Vec::new();
    let mut stream: Option<StreamSound> = None;
    let mut next_stream_id = 0x8000u16;
    let mut ended = false;
    while off < body.len() {
        if body.len() - off < 2 {
            return Err(SwfError::TagOverrun);
        }
        let head = u16le_at(&body, off)?;
        off += 2;
        let code = head >> 6;
        let mut len = (head & 0x3F) as usize;
        if len == 0x3F {
            len = u32le_at(&body, off)? as usize;
            off += 4;
        }
        let end = off.checked_add(len).ok_or(SwfError::TagOverrun)?;
        let tag = body.get(off..end).ok_or(SwfError::TagOverrun)?;
        if code == 0 {
            ended = true;
            break; // End tag
        }
        match code {
            TAG_DEFINE_SOUND => match parse_define_sound(tag) {
                Ok(s) => sounds.push(s),
                Err(sk) => skipped.push(sk),
            },
            TAG_SOUND_STREAM_HEAD | TAG_SOUND_STREAM_HEAD2 => {
                if let Some(previous) = stream.take() {
                    finish_stream(previous, &mut sounds, &mut skipped);
                }
                // StreamSoundCompression is the upper nibble of byte 1.
                let format = tag.get(1).copied().unwrap_or(0) >> 4;
                if format == FORMAT_MP3 && tag.len() >= 6 {
                    stream = Some(StreamSound {
                        id: next_stream_id,
                        sample_count: 0,
                        seek_samples: u16::from_le_bytes([tag[4], tag[5]]),
                        frames: Vec::new(),
                    });
                    next_stream_id = next_stream_id.wrapping_add(1);
                } else {
                    skipped.push(SkippedSound {
                        id: next_stream_id,
                        format,
                        reason: "non-MP3 or malformed streaming sound",
                    });
                    next_stream_id = next_stream_id.wrapping_add(1);
                }
            }
            TAG_SOUND_STREAM_BLOCK => {
                if let Some(active) = stream.as_mut() {
                    // MP3 blocks start with sample count and seek samples; the
                    // remaining bytes are one or more MPEG frames.
                    if tag.len() >= 4 {
                        active.sample_count = active
                            .sample_count
                            .saturating_add(u16::from_le_bytes([tag[0], tag[1]]) as u32);
                        let payload = &tag[4..];
                        if let Some(start) = mp3_frame_start(payload) {
                            active.frames.extend_from_slice(&payload[start..]);
                        }
                    }
                }
            }
            _ => {}
        }
        off = end;
    }
    if !ended {
        return Err(SwfError::TagOverrun);
    }
    if let Some(stream) = stream {
        finish_stream(stream, &mut sounds, &mut skipped);
    }

    Ok(SwfSounds {
        version,
        sounds,
        skipped,
    })
}

#[cfg(test)]
mod tests;
