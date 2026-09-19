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
/// `DefineSound` format id for MP3.
pub const FORMAT_MP3: u8 = 2;
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
    if (data.len() as u64) < u64::from(declared) {
        return Err(SwfError::Truncated {
            declared,
            actual: data.len(),
        });
    }

    match &magic {
        b"FWS" => Ok((version, data[8..declared as usize].to_vec())),
        b"CWS" => {
            let mut dec = flate2::read::ZlibDecoder::new(&data[8..]);
            let mut out = Vec::new();
            dec.read_to_end(&mut out)
                .map_err(|e| SwfError::Decompress(e.to_string()))?;
            if out.len() + 8 != declared as usize {
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
    if format != FORMAT_MP3 {
        return Err(SkippedSound {
            id,
            format,
            reason: "non-MP3 sound codec not supported yet",
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
        sample_count,
        seek_samples: u16::from_le_bytes([tag[7], tag[8]]),
        trimmed_leading: start,
        frames: payload[start..].to_vec(),
    })
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
        if code == TAG_DEFINE_SOUND {
            match parse_define_sound(tag) {
                Ok(s) => sounds.push(s),
                Err(sk) => skipped.push(sk),
            }
        }
        off = end;
    }
    if !ended {
        return Err(SwfError::TagOverrun);
    }

    Ok(SwfSounds {
        version,
        sounds,
        skipped,
    })
}

#[cfg(test)]
mod tests;
