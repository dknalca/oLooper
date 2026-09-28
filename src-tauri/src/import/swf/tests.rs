//! Fixture tests for the SWF parser. All fixtures are synthetic and built
//! in-code: no private user files, nothing required from `loopersFlash/`.

use super::super::fixture::*;
use super::*;

fn push_bits(value: u32, width: usize, bits: &mut Vec<u8>, current: &mut u8, count: &mut usize) {
    for shift in (0..width).rev() {
        *current = (*current << 1) | ((value >> shift) & 1) as u8;
        *count += 1;
        if *count == 8 {
            bits.push(*current);
            *current = 0;
            *count = 0;
        }
    }
}

fn finish_bits(bits: &mut Vec<u8>, current: u8, count: usize) {
    if count != 0 {
        bits.push(current << (8 - count));
    }
}

fn jpeg_fixture(width: u32, height: u32) -> Vec<u8> {
    let pixels = (0..width * height)
        .flat_map(|index| {
            let x = index % width;
            let y = index / width;
            [(x * 7) as u8, (y * 11) as u8, (index * 3) as u8]
        })
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode(&pixels, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

fn jpeg_table_stream(jpeg: &[u8]) -> Vec<u8> {
    let mut tables = jpeg[..2].to_vec();
    let mut offset = 2;
    while offset + 4 <= jpeg.len() && jpeg[offset] == 0xff {
        let marker = jpeg[offset + 1];
        if marker == 0xda {
            break;
        }
        let length = u16::from_be_bytes([jpeg[offset + 2], jpeg[offset + 3]]) as usize;
        let end = offset + 2 + length;
        if end > jpeg.len() {
            break;
        }
        if marker == 0xdb || marker == 0xc4 {
            tables.extend_from_slice(&jpeg[offset..end]);
        }
        offset = end;
    }
    tables.extend_from_slice(&[0xff, 0xd9]);
    tables
}

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
fn extracts_largest_embedded_jpeg_as_swf_cover() {
    let small = jpeg_fixture(2, 2);
    let large = jpeg_fixture(64, 64);
    let mut small_tag = 9u16.to_le_bytes().to_vec();
    small_tag.extend_from_slice(&jpeg_table_stream(&small));
    small_tag.extend_from_slice(&small);
    let mut large_tag = 10u16.to_le_bytes().to_vec();
    large_tag.extend_from_slice(&jpeg_table_stream(&large));
    large_tag.extend_from_slice(&large);
    let mut tags = swf_tag(21, &small_tag);
    tags.extend(swf_tag(21, &large_tag));

    let parsed = parse(&fws_file(10, &tags)).unwrap();
    let decoded = image::load_from_memory(parsed.cover_image.as_deref().unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (64, 64));
}

#[test]
fn reconstructs_jpeg_using_define_bits_and_jpeg_tables() {
    let jpeg = jpeg_fixture(32, 24);
    let tables = jpeg_table_stream(&jpeg);
    let mut table_tag = swf_tag(8, &tables);
    let mut image_tag = 1u16.to_le_bytes().to_vec();
    image_tag.extend_from_slice(&jpeg[2..]);
    table_tag.extend(swf_tag(6, &image_tag));

    let parsed = parse(&fws_file(10, &table_tag)).unwrap();
    let decoded = image::load_from_memory(parsed.cover_image.as_deref().unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (32, 24));
}

#[test]
fn invalid_largest_jpeg_does_not_hide_a_smaller_decodable_cover() {
    let valid = jpeg_fixture(8, 6);
    let mut invalid = vec![0x42; valid.len() + 128];
    invalid[..2].copy_from_slice(&[0xff, 0xd8]);
    let end = invalid.len();
    invalid[end - 2..].copy_from_slice(&[0xff, 0xd9]);

    let mut invalid_tag = 1u16.to_le_bytes().to_vec();
    invalid_tag.extend_from_slice(&invalid);
    let mut valid_tag = 2u16.to_le_bytes().to_vec();
    valid_tag.extend_from_slice(&valid);
    let mut tags = swf_tag(TAG_DEFINE_BITS_JPEG2, &invalid_tag);
    tags.extend(swf_tag(TAG_DEFINE_BITS_JPEG2, &valid_tag));

    let parsed = parse(&fws_file(10, &tags)).unwrap();
    let decoded = image::load_from_memory(parsed.cover_image.as_deref().unwrap()).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (8, 6));
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
    assert!(
        file.len() < declared,
        "fixture must exercise compressed CWS sizing"
    );
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
fn streaming_mp3_blocks_are_assembled() {
    // SoundStreamHead: playback flags, MP3 stream flags, sample count, latency.
    let head = swf_tag(18, &[0x0F, 0x2F, 0x00, 0x00, 0x00, 0x00]);
    let mut first = 3u16.to_le_bytes().to_vec();
    first.extend_from_slice(&0i16.to_le_bytes());
    first.extend_from_slice(&fake_mp3(0)[2..8]);
    let mut second = 3u16.to_le_bytes().to_vec();
    second.extend_from_slice(&0i16.to_le_bytes());
    second.extend_from_slice(&fake_mp3(0)[8..]);
    let mut tags = head;
    tags.extend(swf_tag(19, &first));
    tags.extend(swf_tag(19, &second));
    let parsed = parse(&fws_file(10, &tags)).unwrap();
    assert_eq!(parsed.sounds.len(), 1);
    assert_eq!(parsed.sounds[0].id, 0x8000);
    assert_eq!(parsed.sounds[0].sample_count, 6);
    assert_eq!(parsed.sounds[0].frames, fake_mp3(0)[2..]);
}

#[test]
fn adpcm_sound_is_decoded_to_wav() {
    let mut bits = Vec::new();
    let mut current = 0u8;
    let mut count = 0usize;
    push_bits(0, 2, &mut bits, &mut current, &mut count); // 2-bit ADPCM codes
    push_bits(0, 16, &mut bits, &mut current, &mut count); // initial sample
    push_bits(0, 6, &mut bits, &mut current, &mut count); // initial index
    push_bits(0, 2, &mut bits, &mut current, &mut count); // one delta sample
    finish_bits(&mut bits, current, count);
    let mut tag = define_sound_tag(9, FORMAT_ADPCM, &bits);
    tag[5..9].copy_from_slice(&2u32.to_le_bytes());
    let parsed = parse(&fws_file(10, &tag)).unwrap();
    assert_eq!(parsed.sounds[0].codec, "wav");
    assert_eq!(&parsed.sounds[0].frames[..4], b"RIFF");
}

#[test]
fn adpcm_resets_its_predictor_every_4095_samples() {
    let mut bits = Vec::new();
    let mut current = 0u8;
    let mut count = 0usize;
    push_bits(0, 2, &mut bits, &mut current, &mut count);
    push_bits(1_000, 16, &mut bits, &mut current, &mut count);
    push_bits(0, 6, &mut bits, &mut current, &mut count);
    for _ in 1..4095 {
        push_bits(0, 2, &mut bits, &mut current, &mut count);
    }
    push_bits(2_000, 16, &mut bits, &mut current, &mut count);
    push_bits(0, 6, &mut bits, &mut current, &mut count);
    finish_bits(&mut bits, current, count);
    let wav = wav_from_adpcm(&bits, 0x1E, 4096).expect("valid ADPCM");
    let offset = 44 + 4095 * 2;
    assert_eq!(
        i16::from_le_bytes(wav[offset..offset + 2].try_into().unwrap()),
        2_000
    );
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
    assert_eq!(parse(&f).unwrap_err(), SwfError::DeclaredTooLarge(u32::MAX));
}

#[test]
fn tag_overrun_rejected() {
    let mut tags = vec![0xFF, 0xFF]; // huge code, len follows
    tags.extend_from_slice(&u32::MAX.to_le_bytes());
    let r = parse(&fws_file(5, &tags));
    assert_eq!(r.unwrap_err(), SwfError::TagOverrun);
}

/// Dev-only regression fixture. The large proprietary sample is gitignored.
/// Run: `OLOOPER_TURNTABLE_FIXTURE=/path/to/file.swf cargo test -- --ignored turntable_fixture`.
#[test]
#[ignore]
fn turntable_fixture_extracts_sounds() {
    let path = std::env::var("OLOOPER_TURNTABLE_FIXTURE")
        .expect("set OLOOPER_TURNTABLE_FIXTURE to the SWF fixture path");
    let data = std::fs::read(path).unwrap();
    let parsed = parse(&data).unwrap();
    if parsed.sounds.is_empty() {
        let (_, body) = body_bytes(&data).unwrap();
        let mut off = rect_len(&body).unwrap() + 4;
        let mut tags = std::collections::BTreeMap::<u16, (usize, usize)>::new();
        while off + 2 <= body.len() {
            let head = u16le_at(&body, off).unwrap();
            off += 2;
            let code = head >> 6;
            let len = if head & 0x3F == 0x3F {
                let len = u32le_at(&body, off).unwrap() as usize;
                off += 4;
                len
            } else {
                (head & 0x3F) as usize
            };
            let entry = tags.entry(code).or_default();
            entry.0 += 1;
            entry.1 += len;
            off += len;
            if code == 0 {
                break;
            }
        }
        panic!(
            "no extractable MP3 tags; skipped: {:?}; tag inventory: {tags:?}",
            parsed.skipped
        );
    }
    for sound in &parsed.sounds {
        crate::player::decode_bytes(&sound.frames).expect("extracted sound must decode");
    }
}
