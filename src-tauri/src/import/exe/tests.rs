//! Fixture tests for the EXE locator. Synthetic stubs only.

use super::*;

fn fws_payload(sound_id: u16) -> Vec<u8> {
    // Minimal FWS v5: empty RECT + rate + count + one MP3 DefineSound + End.
    let mut body = vec![0x00u8, 0x00, 0x00, 0x01, 0x00];
    let mut snd = sound_id.to_le_bytes().to_vec();
    snd.push(super::super::swf::FORMAT_MP3 << 4);
    snd.extend_from_slice(&1000u32.to_le_bytes());
    snd.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFB, 0x90, 0x00]);
    let mut tag = ((14u16 << 6) | snd.len() as u16).to_le_bytes().to_vec();
    tag.extend_from_slice(&snd);
    body.extend_from_slice(&tag);
    body.extend_from_slice(&[0x00, 0x00]);
    let mut f = b"FWS".to_vec();
    f.push(5);
    f.extend_from_slice(&((body.len() + 8) as u32).to_le_bytes());
    f.extend_from_slice(&body);
    f
}

fn projector_stub(payload: &[u8]) -> Vec<u8> {
    let mut exe = b"MZ".to_vec();
    exe.extend_from_slice(&[0x90, 0x00, b'S', b'T', b'U', b'B']);
    exe.extend_from_slice(&[0xAA; 512]); // fake projector header area
    exe.extend_from_slice(payload);
    exe.extend_from_slice(&[0x00; 8]); // overlay trailer, as seen in the wild
    exe
}

fn cws_payload(sound_id: u16) -> Vec<u8> {
    use std::io::Write as _;
    let fws = fws_payload(sound_id);
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&fws[8..]).unwrap();
    let mut cws = b"CWS".to_vec();
    cws.push(fws[3]);
    cws.extend_from_slice(&fws[4..8]);
    cws.extend_from_slice(&encoder.finish().unwrap());
    cws
}

#[test]
fn stub_with_appended_swf_locates_and_extracts() {
    let swf = fws_payload(9);
    let exe = projector_stub(&swf);
    let found = locate(&exe).unwrap();
    assert_eq!(found.offset, 2 + 6 + 512);
    assert_eq!(found.length, swf.len());
    let sounds = extract(&exe).unwrap();
    assert_eq!(sounds.sounds.len(), 1);
    assert_eq!(sounds.sounds[0].id, 9);
}

#[test]
fn stub_with_compressed_swf_uses_remaining_overlay_bytes() {
    let cws = cws_payload(11);
    let exe = projector_stub(&cws);
    let found = locate(&exe).unwrap();
    assert_eq!(found.offset, 2 + 6 + 512);
    assert_eq!(extract(&exe).unwrap().sounds[0].id, 11);
}

#[test]
fn exe_without_swf_is_unsupported() {
    let exe = b"MZSTUB".to_vec();
    assert!(matches!(locate(&exe), Err(ExeError::UnsupportedExe { .. })));
}

#[test]
fn non_exe_rejected() {
    assert_eq!(locate(b"FWS...").unwrap_err(), ExeError::NotAnExe);
    assert_eq!(locate(&[]).unwrap_err(), ExeError::TooSmall);
}

#[test]
fn truncated_embedded_swf_is_skipped_safely() {
    let mut swf = fws_payload(1);
    swf.truncate(swf.len() - 12); // declared length no longer fits in the file
    let exe = projector_stub(&swf);
    assert!(matches!(locate(&exe), Err(ExeError::UnsupportedExe { .. })));
}

#[test]
fn largest_valid_candidate_wins() {
    let small = fws_payload(1);
    let mut big = fws_payload(2);
    // Pad the big one with extra End tags, then fix its declared length.
    big.pop();
    big.pop();
    big.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    let new_len = big.len() as u32;
    big[4..8].copy_from_slice(&new_len.to_le_bytes());
    let mut exe = projector_stub(&small);
    // Rebuild header length after padding: easiest is to append big after small.
    exe.extend_from_slice(&big);
    let found = locate(&exe).unwrap();
    assert_eq!(found.length, big.len());
}

#[test]
fn larger_content_wins_over_earlier_cws_stub() {
    // Regression (collec_vol4): a small valid CWS loader stub placed BEFORE
    // a larger valid CWS movie. The stub's stored slice (rest-of-file) is
    // longer on disk, but the movie's declared content is larger, so the
    // movie must win — otherwise a soundless stub shadows real content.
    use std::io::Write as _;
    let mut big_fws = fws_payload(2);
    big_fws.pop();
    big_fws.pop();
    big_fws.extend_from_slice(&[0x00u8; 64]); // extra End tags
    let new_len = big_fws.len() as u32;
    big_fws[4..8].copy_from_slice(&new_len.to_le_bytes());
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&big_fws[8..]).unwrap();
    let mut big = b"CWS".to_vec();
    big.push(big_fws[3]);
    big.extend_from_slice(&big_fws[4..8]);
    big.extend_from_slice(&enc.finish().unwrap());
    let small = cws_payload(1);
    assert!(big.len() > small.len());
    let mut exe = b"MZ".to_vec();
    exe.extend_from_slice(&[0xAA; 64]);
    let big_off = exe.len() + small.len();
    exe.extend_from_slice(&small);
    exe.extend_from_slice(&big);
    let found = locate(&exe).unwrap();
    assert_eq!(found.offset, big_off);
    assert_eq!(extract(&exe).unwrap().sounds[0].id, 2);
}
