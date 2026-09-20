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
