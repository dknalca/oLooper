//! Flash-projector `.exe` handling: locate an embedded SWF, then reuse
//! the [`crate::import::swf`] pipeline. The file is data; never executed.

use std::fmt;

/// Cap on stored scan candidates (scan itself is a single linear pass).
const MAX_CANDIDATES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExeError {
    TooSmall,
    NotAnExe,
    UnsupportedExe {
        candidates: usize,
        detail: &'static str,
    },
    Swf(super::swf::SwfError),
}

impl fmt::Display for ExeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooSmall => write!(f, "file too small to be an executable"),
            Self::NotAnExe => write!(f, "not a Windows executable (no MZ header)"),
            Self::UnsupportedExe { candidates, detail } => write!(
                f,
                "no compatible embedded SWF found ({candidates} raw candidates, {detail})"
            ),
            Self::Swf(e) => write!(f, "embedded SWF invalid: {e}"),
        }
    }
}

impl std::error::Error for ExeError {}

pub fn user_message(e: &ExeError) -> String {
    match e {
        ExeError::Swf(inner) => format!(
            "{}. The original file was not modified. Try the raw .swf if you have it.",
            super::swf::user_message(inner)
        ),
        _ => format!(
            "{e}. The original file was not modified. Only Flash projector executables with an embedded SWF are supported."
        ),
    }
}

/// Location of an embedded SWF inside the `.exe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedSwf {
    pub offset: usize,
    pub length: usize,
}

fn is_magic_at(data: &[u8], off: usize) -> Option<(&'static str, u8, u32)> {
    let m = data.get(off..off + 8)?;
    let magic = match &m[0..3] {
        [b'F', b'W', b'S'] => "FWS",
        [b'C', b'W', b'S'] => "CWS",
        [b'Z', b'W', b'S'] => "ZWS",
        _ => return None,
    };
    let version = m[3];
    let length = u32::from_le_bytes([m[4], m[5], m[6], m[7]]);
    Some((magic, version, length))
}

/// Raw scan: every magic occurrence with a sane version and a length that
/// fits inside the file. Cheap checks only; full validation happens in
/// [`locate`] on the largest candidates first.
pub fn scan(data: &[u8]) -> Vec<EmbeddedSwf> {
    let mut out = Vec::new();
    if data.len() < 8 {
        return out;
    }
    for off in 0..data.len() - 7 {
        let Some((_, version, length)) = is_magic_at(data, off) else {
            continue;
        };
        if version == 0 || version > super::swf::MAX_VERSION {
            continue;
        }
        let len = length as usize;
        if len < 8
            || off
                .checked_add(len)
                .map(|end| end > data.len())
                .unwrap_or(true)
        {
            continue;
        }
        // Skip candidates fully inside an already-accepted larger one? No:
        // keep it simple, prefer largest valid later.
        if out.len() < MAX_CANDIDATES {
            out.push(EmbeddedSwf {
                offset: off,
                length: len,
            });
        }
    }
    out
}

/// Locate the embedded SWF: MZ check, scan, then validate largest-first.
/// The first candidate that fully parses wins.
pub fn locate(data: &[u8]) -> Result<EmbeddedSwf, ExeError> {
    if data.len() < 2 {
        return Err(ExeError::TooSmall);
    }
    if &data[0..2] != b"MZ" {
        return Err(ExeError::NotAnExe);
    }
    let mut cands = scan(data);
    // Largest first; FWS preferred on ties (simpler container, fewer false positives).
    cands.sort_by_key(|c| {
        let is_fws = data[c.offset] == b'F';
        (std::cmp::Reverse(c.length), !is_fws)
    });

    let mut saw_zws = false;
    for c in &cands {
        if &data[c.offset..c.offset + 3] == b"ZWS" {
            saw_zws = true;
            continue;
        }
        if super::swf::parse(&data[c.offset..c.offset + c.length]).is_ok() {
            return Ok(*c);
        }
    }
    Err(ExeError::UnsupportedExe {
        candidates: cands.len(),
        detail: if saw_zws {
            "only LZMA-compressed candidates"
        } else {
            "no candidate parsed as SWF"
        },
    })
}

/// Convenience: locate + parse in one step.
pub fn extract(data: &[u8]) -> Result<super::swf::SwfSounds, ExeError> {
    let found = locate(data)?;
    super::swf::parse(&data[found.offset..found.offset + found.length]).map_err(ExeError::Swf)
}

#[cfg(test)]
mod tests;
