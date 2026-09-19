//! Fixture tests for the SWF parser. All fixtures are synthetic and built
//! in-code: no private user files, nothing required from `loopersFlash/`.

use super::super::fixture::*;
use super::*;

#[test]
fn valid_fws_extracts_mp3_in_order() {
    let mut tags = define_sound_tag(7, FORMAT_MP3, &fake_mp3(0));
    tags.extend(define_sound_tag(3, FORMAT_MP3, &fake_mp3(2112)));
    let r = parse(&fws_file(5, &tags)).unwrap();
    assert_eq!(r.version, 5);
    assert_eq!(r.sounds.len(), 2);
    assert_eq!(r.sounds[0].id, 7);
    assert_eq!(r.sounds[1].id, 3);
    assert_eq!(r.sounds[1].seek_samples, 2112);
    assert_eq!(r.sounds[0].frames, fake_mp3(0)[2..]);
    assert!(r.skipped.is_empty());
}

#[test]
fn valid_cws_extracts_mp3() {
    // Compressible padding makes the on-disk CWS smaller than its declared
    // uncompressed length, as real CWS files normally are.
    let mut payload = vec![0; 4096];
    payload.extend(fake_mp3(0));
    let tags = define_sound_tag(1, FORMAT_MP3, &payload);
    let file = cws_file(6, &tags);
    let declared = u32::from_le_bytes(file[4..8].try_into().unwrap()) as usize;
    assert!(file.len() < declared, "fixture must exercise compressed CWS sizing");
    let r = parse(&file).unwrap();
    assert_eq!(r.sounds.len(), 1);
    assert_eq!(r.sounds[0].frames, fake_mp3(0)[2..]);
}

#[test]
fn leading_zero_padding_is_stripped() {
    // Authoring tools prepend non-frame padding (seen: 417 zero bytes).
    let mut payload = vec![0u8; 417];
    payload.extend_from_slice(&fake_mp3(0));
    let tags = define_sound_tag(5, FORMAT_MP3, &payload);
    let r = parse(&fws_file(5, &tags)).unwrap();
    assert_eq!(r.sounds.len(), 1);
    assert_eq!(r.sounds[0].trimmed_leading, 417);
    assert_eq!(r.sounds[0].frames, fake_mp3(0)[2..]);
}

#[test]
fn mp3_without_frame_sync_is_skipped() {
    let tags = define_sound_tag(5, FORMAT_MP3, &[0x00, 0x00, 0x11, 0x22, 0x33]);
    let r = parse(&fws_file(5, &tags)).unwrap();
    assert!(r.sounds.is_empty());
    assert_eq!(r.skipped.len(), 1);
}
#[test]
fn unsupported_codec_is_skipped_not_fatal() {
    let mut tags = define_sound_tag(1, 1, &[0x00, 0x00, 0xAA]); // ADPCM-ish
    tags.extend(define_sound_tag(2, FORMAT_MP3, &fake_mp3(0)));
    let r = parse(&fws_file(5, &tags)).unwrap();
    assert_eq!(r.sounds.len(), 1);
    assert_eq!(r.sounds[0].id, 2);
    assert_eq!(r.skipped.len(), 1);
    assert_eq!(r.skipped[0].id, 1);
}

#[test]
fn bad_magic_rejected() {
    let mut f = fws_file(5, &[]);
    f[0] = b'X';
    assert_eq!(parse(&f).unwrap_err(), SwfError::BadMagic(*b"XWS"));
}

#[test]
fn truncated_rejected_without_panic() {
    let mut f = fws_file(5, &define_sound_tag(1, FORMAT_MP3, &fake_mp3(0)));
    f.truncate(f.len() - 4);
    assert!(matches!(parse(&f), Err(SwfError::Truncated { .. })));
}

#[test]
fn zws_reported_unsupported() {
    let mut f = fws_file(5, &[]);
    f[0] = b'Z';
    assert_eq!(
        parse(&f).unwrap_err(),
        SwfError::UnsupportedCompression("ZWS/LZMA")
    );
}

#[test]
fn oversized_declaration_rejected() {
    let mut f = fws_file(5, &[]);
    f[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(
        parse(&f).unwrap_err(),
        SwfError::DeclaredTooLarge(u32::MAX)
    );
}

#[test]
fn tag_overrun_rejected() {
    let mut tags = vec![0xFF, 0xFF]; // huge code, len follows
    tags.extend_from_slice(&u32::MAX.to_le_bytes());
    let r = parse(&fws_file(5, &tags));
    assert_eq!(r.unwrap_err(), SwfError::TagOverrun);
}
