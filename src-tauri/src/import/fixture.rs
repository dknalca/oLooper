//! Synthetic fixtures shared by test modules. In-code only: nothing from
//! `loopersFlash/`, nothing committed as binary.

/// Minimal MP3-ish payload: SeekSamples + two fake frames with sync bytes.
#[cfg(test)]
pub fn fake_mp3(seek: u16) -> Vec<u8> {
    let mut v = seek.to_le_bytes().to_vec();
    v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00, 0x01, 0x02]);
    v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00, 0x03, 0x04]);
    v
}

#[cfg(test)]
pub fn define_sound_tag(id: u16, format: u8, payload: &[u8]) -> Vec<u8> {
    const TAG_DEFINE_SOUND: u16 = 14;
    let mut body = id.to_le_bytes().to_vec();
    body.push(format << 4);
    body.extend_from_slice(&44100u32.to_le_bytes());
    body.extend_from_slice(payload);
    let mut tag = Vec::new();
    if body.len() < 0x3F {
        tag.extend_from_slice(&((TAG_DEFINE_SOUND << 6) | body.len() as u16).to_le_bytes());
    } else {
        tag.extend_from_slice(&((TAG_DEFINE_SOUND << 6) | 0x3F).to_le_bytes());
        tag.extend_from_slice(&(body.len() as u32).to_le_bytes());
    }
    tag.extend_from_slice(&body);
    tag
}

#[cfg(test)]
pub fn swf_tag(code: u16, body: &[u8]) -> Vec<u8> {
    let mut tag = Vec::new();
    if body.len() < 0x3F {
        tag.extend_from_slice(&((code << 6) | body.len() as u16).to_le_bytes());
    } else {
        tag.extend_from_slice(&((code << 6) | 0x3F).to_le_bytes());
        tag.extend_from_slice(&(body.len() as u32).to_le_bytes());
    }
    tag.extend_from_slice(body);
    tag
}

/// Minimal body: empty RECT + rate + count + tags + End.
#[cfg(test)]
pub fn swf_body(tags: &[u8]) -> Vec<u8> {
    let mut b = vec![0x00];
    b.extend_from_slice(&[0x00, 0x00]);
    b.extend_from_slice(&[0x01, 0x00]);
    b.extend_from_slice(tags);
    b.extend_from_slice(&[0x00, 0x00]);
    b
}

#[cfg(test)]
pub fn fws_file(version: u8, tags: &[u8]) -> Vec<u8> {
    let body = swf_body(tags);
    let mut f = b"FWS".to_vec();
    f.push(version);
    f.extend_from_slice(&((body.len() + 8) as u32).to_le_bytes());
    f.extend_from_slice(&body);
    f
}

#[cfg(test)]
pub fn cws_file(version: u8, tags: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let body = swf_body(tags);
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&body).unwrap();
    let comp = enc.finish().unwrap();
    let mut f = b"CWS".to_vec();
    f.push(version);
    f.extend_from_slice(&((body.len() + 8) as u32).to_le_bytes());
    f.extend_from_slice(&comp);
    f
}
