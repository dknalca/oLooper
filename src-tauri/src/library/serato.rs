//! Serato marker metadata embedded into oLooper-managed audio copies.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use id3::frame::{EncapsulatedObject, Picture, PictureType};
use id3::{ErrorKind, Tag, TagLike, Version};
use lofty::config::{ParseOptions, WriteOptions};
use lofty::file::AudioFile;
use lofty::flac::FlacFile;
use lofty::ogg::tag::VorbisComments;
use lofty::ogg::VorbisFile;
use mp4ameta::{Data as Mp4Data, DataIdent as Mp4DataIdent, Tag as Mp4Tag};

use super::{SeratoCue, SeratoLoop, SeratoMetadata};

const MARKERS_DESCRIPTION: &str = "Serato Markers_";
const MARKERS2_DESCRIPTION: &str = "Serato Markers2";
const MARKER_BYTES: usize = 22;
const APP_CUE_COUNT: usize = 4;
const APP_LOOP_COUNT: usize = 8;
const LEGACY_CUE_COUNT: usize = 5;
const LEGACY_LOOP_COUNT: usize = 9;
const MARKERS2_MINIMUM_SIZE: usize = 470;
const MAX_MARKERS2_BYTES: usize = 1_048_576;
const SERATO_MARKERS2_FLAC_KEY: &str = "SERATO_MARKERS_V2";
const SERATO_MARKERS2_OGG_KEY: &str = "serato_markers2";
const SERATO_MP4_MEAN: &str = "com.serato.dj";
const SERATO_MP4_MARKERS_NAME: &str = "markers";
const SERATO_MP4_MARKERS2_NAME: &str = "markersv2";
const SERATO_ENVELOPE_MIME: &[u8] = b"application/octet-stream\0\0";
const MAX_SERATO_POSITION_MS: i64 = 0x00ff_ffff;
const CUE_COLORS: [u32; APP_CUE_COUNT] = [0xCC0000, 0xCC8800, 0x0000CC, 0xCCCC00];
const LOOP_COLOR: u32 = 0x27AAE1;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ExistingMarkers {
    version: Option<[u8; 2]>,
    cues: Vec<Vec<u8>>,
    loops: Vec<Vec<u8>>,
    other: Vec<Vec<u8>>,
    track_color: Option<[u8; 4]>,
    mp4_footer: Option<u8>,
}

#[derive(Default)]
struct ExistingMarkers2 {
    outer_version: Option<[u8; 2]>,
    content_version: Option<[u8; 2]>,
    entries: Vec<Markers2Entry>,
}

struct Markers2Entry {
    name: String,
    index: Option<u8>,
    raw: Vec<u8>,
}

pub(super) struct ReadAudioMetadata {
    pub metadata: SeratoMetadata,
    pub markers_present: bool,
    pub needs_wave_id3_normalization: bool,
}

#[derive(Clone, Copy)]
enum MarkerContainer {
    Id3,
    Flac,
    Ogg,
    Mp4,
}

const MAX_ID3_CHUNK_BYTES: u32 = 64 * 1024 * 1024;

struct AudioTag {
    tag: Tag,
    needs_wave_id3_normalization: bool,
}

fn read_audio_tag(path: &Path) -> Result<AudioTag, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot read audio metadata: {error}"))?;
    let mut header = [0u8; 12];
    let header_read = file.read_exact(&mut header);
    if header_read.is_ok() && header[..4] == *b"RIFF" && header[8..12] == *b"WAVE" {
        return read_wave_id3_tag(file, header);
    }
    match Tag::read_from_path(path) {
        Ok(tag) => Ok(AudioTag {
            tag,
            needs_wave_id3_normalization: false,
        }),
        Err(error) if matches!(error.kind, ErrorKind::NoTag) => Ok(AudioTag {
            tag: Tag::new(),
            needs_wave_id3_normalization: false,
        }),
        Err(error) => Err(format!("cannot read audio metadata: {error}")),
    }
}

fn read_wave_id3_tag(mut file: File, header: [u8; 12]) -> Result<AudioTag, String> {
    let file_size = file
        .metadata()
        .map_err(|error| format!("cannot inspect WAV metadata: {error}"))?
        .len();
    let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64;
    let riff_end = riff_size.checked_add(8).ok_or("invalid WAV size")?;
    if riff_end < 12 || riff_end > file_size {
        return Err("WAV has an invalid RIFF size".to_string());
    }

    let mut offset = 12u64;
    let mut id3_chunks = Vec::<(bool, Tag)>::new();
    while offset + 8 <= riff_end {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("cannot seek WAV chunks: {error}"))?;
        let mut chunk_header = [0u8; 8];
        file.read_exact(&mut chunk_header)
            .map_err(|error| format!("truncated WAV chunk header: {error}"))?;
        let size = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap());
        let data_start = offset + 8;
        let data_end = data_start
            .checked_add(size as u64)
            .ok_or("invalid WAV chunk size")?;
        let next = data_end + u64::from(size & 1);
        if next > riff_end {
            return Err("WAV chunk extends beyond the RIFF container".to_string());
        }

        if chunk_header[..4].eq_ignore_ascii_case(b"ID3 ") {
            if size > MAX_ID3_CHUNK_BYTES {
                return Err("WAV ID3 chunk is too large".to_string());
            }
            let mut contents = vec![0; size as usize];
            file.read_exact(&mut contents)
                .map_err(|error| format!("cannot read WAV ID3 chunk: {error}"))?;
            let lower_case = chunk_header[..4] == *b"id3 ";
            match Tag::read_from2(Cursor::new(contents)) {
                Ok(tag) => id3_chunks.push((lower_case, tag)),
                Err(error) if matches!(error.kind, ErrorKind::NoTag) => {}
                Err(error) => {
                    return Err(format!("cannot decode WAV ID3 chunk: {error}"));
                }
            }
        }
        offset = next;
    }

    if id3_chunks.is_empty() {
        return Ok(AudioTag {
            tag: Tag::new(),
            needs_wave_id3_normalization: false,
        });
    }
    let needs_wave_id3_normalization =
        id3_chunks.len() > 1 || !id3_chunks.iter().any(|(lowercase, _)| *lowercase);
    let lower = id3_chunks
        .iter()
        .find(|(lower, _)| *lower)
        .map(|(_, tag)| tag);
    let upper = id3_chunks
        .iter()
        .find(|(lower, _)| !*lower)
        .map(|(_, tag)| tag);
    // The lowercase chunk is Serato's authoritative tag, including when all
    // its markers have been cleared. Only fall back to an older uppercase tag
    // if the lowercase chunk never contained marker frames at all.
    let selected_markers = match (lower, upper) {
        (Some(lower), Some(upper)) if !lower.frames().any(is_serato_marker_frame) => upper,
        (Some(lower), _) => lower,
        (None, Some(upper)) => upper,
        (None, None) => unreachable!(),
    };

    // Preserve ordinary ID3 frames from both chunks, then let the populated
    // Serato marker set win. This repairs WAVs previously written with an
    // uppercase ID3 chunk alongside Serato's lowercase `id3 ` chunk.
    let mut merged = Tag::new();
    for (_, tag) in &id3_chunks {
        for frame in tag.frames() {
            if !is_serato_marker_frame(frame) {
                merged.add_frame(frame.clone());
            }
        }
    }
    for frame in selected_markers.frames() {
        if is_serato_marker_frame(frame) {
            merged.add_frame(frame.clone());
        }
    }

    Ok(AudioTag {
        tag: merged,
        needs_wave_id3_normalization,
    })
}

fn is_serato_marker_frame(frame: &id3::Frame) -> bool {
    frame.id() == "GEOB"
        && frame.content().encapsulated_object().is_some_and(|object| {
            object.description == MARKERS_DESCRIPTION || object.description == MARKERS2_DESCRIPTION
        })
}

fn write_audio_tag(path: &Path, tag: &Tag) -> Result<(), String> {
    if is_wave_file(path)? {
        rewrite_wave_id3_tag(path, tag)
    } else {
        tag.write_to_path(path, Version::Id3v23)
            .map_err(|error| format!("cannot write audio ID3 metadata: {error}"))
    }
}

fn is_wave_file(path: &Path) -> Result<bool, String> {
    let mut file =
        File::open(path).map_err(|error| format!("cannot inspect audio file: {error}"))?;
    let mut header = [0u8; 12];
    if file.read_exact(&mut header).is_err() {
        return Ok(false);
    }
    Ok(header[..4] == *b"RIFF" && header[8..12] == *b"WAVE")
}

fn rewrite_wave_id3_tag(path: &Path, tag: &Tag) -> Result<(), String> {
    let mut encoded_tag = Vec::new();
    tag.write_to(&mut encoded_tag, Version::Id3v23)
        .map_err(|error| format!("cannot encode WAV ID3 metadata: {error}"))?;

    let parent = path
        .parent()
        .ok_or_else(|| "WAV has no parent directory".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("track");
    let (replacement, mut output) = (1..10_000)
        .find_map(|_| {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{name}.serato-rewrite-{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .ok_or_else(|| "cannot allocate temporary Serato WAV file".to_string())?
        .map_err(|error| format!("cannot create temporary Serato WAV file: {error}"))?;

    let rewrite_result = (|| -> Result<(), String> {
        let mut source = File::open(path).map_err(|error| format!("cannot read WAV: {error}"))?;
        let file_size = source
            .metadata()
            .map_err(|error| format!("cannot inspect WAV size: {error}"))?
            .len();
        let mut header = [0u8; 12];
        source
            .read_exact(&mut header)
            .map_err(|error| format!("cannot read WAV header: {error}"))?;
        let riff_size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64;
        let riff_end = riff_size.checked_add(8).ok_or("invalid WAV size")?;
        if header[..4] != *b"RIFF"
            || header[8..12] != *b"WAVE"
            || riff_end > file_size
            || riff_end < 12
        {
            return Err("WAV has an invalid RIFF container".to_string());
        }
        output
            .write_all(&header)
            .map_err(|error| format!("cannot write WAV header: {error}"))?;

        let mut offset = 12u64;
        let mut wrote_tag = false;
        while offset + 8 <= riff_end {
            source
                .seek(SeekFrom::Start(offset))
                .map_err(|error| format!("cannot seek WAV chunks: {error}"))?;
            let mut chunk_header = [0u8; 8];
            source
                .read_exact(&mut chunk_header)
                .map_err(|error| format!("truncated WAV chunk header: {error}"))?;
            let size = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap());
            let end = offset
                .checked_add(8 + size as u64 + u64::from(size & 1))
                .ok_or("invalid WAV chunk size")?;
            if end > riff_end {
                return Err("WAV chunk extends beyond the RIFF container".to_string());
            }
            if chunk_header[..4].eq_ignore_ascii_case(b"ID3 ") {
                if !wrote_tag {
                    write_wave_id3_chunk(&mut output, &encoded_tag)?;
                    wrote_tag = true;
                }
            } else {
                source
                    .seek(SeekFrom::Start(offset))
                    .map_err(|error| format!("cannot seek WAV chunk: {error}"))?;
                let mut chunk = (&mut source).take(end - offset);
                io::copy(&mut chunk, &mut output)
                    .map_err(|error| format!("cannot preserve WAV chunk: {error}"))?;
            }
            offset = end;
        }
        if !wrote_tag {
            write_wave_id3_chunk(&mut output, &encoded_tag)?;
        }
        if file_size > riff_end {
            source
                .seek(SeekFrom::Start(riff_end))
                .map_err(|error| format!("cannot seek WAV trailing data: {error}"))?;
            io::copy(&mut source, &mut output)
                .map_err(|error| format!("cannot preserve WAV trailing data: {error}"))?;
        }
        let output_size = output
            .stream_position()
            .map_err(|error| format!("cannot measure rewritten WAV: {error}"))?;
        let riff_size = u32::try_from(output_size.saturating_sub(8))
            .map_err(|_| "WAV is too large to update Serato metadata")?;
        output
            .seek(SeekFrom::Start(4))
            .and_then(|_| output.write_all(&riff_size.to_le_bytes()))
            .map_err(|error| format!("cannot update WAV RIFF size: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("cannot flush Serato WAV metadata: {error}"))?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = rewrite_result {
        let _ = fs::remove_file(&replacement);
        return Err(error);
    }
    replace_file(&replacement, path)
}

fn write_wave_id3_chunk(writer: &mut impl Write, tag: &[u8]) -> Result<(), String> {
    let size = u32::try_from(tag.len()).map_err(|_| "WAV ID3 tag is too large")?;
    writer
        .write_all(b"id3 ")
        .and_then(|_| writer.write_all(&size.to_le_bytes()))
        .and_then(|_| writer.write_all(tag))
        .map_err(|error| format!("cannot write Serato WAV ID3 chunk: {error}"))?;
    if size & 1 == 1 {
        writer
            .write_all(&[0])
            .map_err(|error| format!("cannot pad Serato WAV ID3 chunk: {error}"))?;
    }
    Ok(())
}

fn check_supported_path(path: &Path) -> Result<MarkerContainer, String> {
    let container = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" | "wav" | "aif" | "aiff" | "aifc" => MarkerContainer::Id3,
        "flac" => MarkerContainer::Flac,
        "ogg" | "oga" => MarkerContainer::Ogg,
        "m4a" | "mp4" => MarkerContainer::Mp4,
        "aac" => {
            return Err("Raw AAC uses Serato XML sidecars rather than embedded audio tags; CUE/loop sync is unsupported for .aac".to_string());
        }
        extension => {
            return Err(format!(
                "Audio-file CUE/loop metadata supports MP3, WAV, AIFF, FLAC, Ogg Vorbis, and MP4/M4A; this track is .{extension}"
            ));
        }
    };
    if !path.is_file() {
        return Err("library audio file is missing".to_string());
    }
    Ok(container)
}

/// Read CUEs from the audio file every time a track is opened. Serato loops are
/// parsed only so marker updates can preserve them; oLooper does not edit them.
pub(super) fn read_audio_file(path: &Path) -> Result<ReadAudioMetadata, String> {
    let container = check_supported_path(path)?;
    match container {
        MarkerContainer::Id3 => read_id3_audio_file(path),
        MarkerContainer::Flac => read_vorbis_audio_file(path, true),
        MarkerContainer::Ogg => read_vorbis_audio_file(path, false),
        MarkerContainer::Mp4 => read_mp4_audio_file(path),
    }
}

fn read_id3_audio_file(path: &Path) -> Result<ReadAudioMetadata, String> {
    let audio_tag = read_audio_tag(path)?;
    let tag = audio_tag.tag;
    let markers = tag
        .encapsulated_objects()
        .find(|object| object.description == MARKERS_DESCRIPTION)
        .map(|object| parse_markers(&object.data))
        .transpose()?;
    let markers2_data = tag
        .encapsulated_objects()
        .find(|object| object.description == MARKERS2_DESCRIPTION)
        .map(|object| object.data.as_slice());
    let markers2 = match markers2_data {
        Some(data) => match parse_markers2(data) {
            Ok(markers2) => Some(markers2),
            Err(_) if markers.is_some() => None,
            Err(error) => return Err(error),
        },
        None => None,
    };
    let bpm = tag
        .get("TBPM")
        .and_then(|frame| frame.content().text())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| (20.0..=300.0).contains(value));
    let markers_present = marker_sources_present(markers.as_ref(), markers2.as_ref());
    let metadata = merge_marker_sources(markers.as_ref(), markers2.as_ref(), bpm)?;
    Ok(ReadAudioMetadata {
        metadata,
        markers_present,
        needs_wave_id3_normalization: audio_tag.needs_wave_id3_normalization,
    })
}

fn read_vorbis_audio_file(path: &Path, flac: bool) -> Result<ReadAudioMetadata, String> {
    let (marker_value, bpm_value) = if flac {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let tagged = FlacFile::read_from(&mut file, ParseOptions::default())
            .map_err(|error| format!("cannot read FLAC metadata: {error}"))?;
        let comments = tagged.vorbis_comments();
        (
            comments
                .and_then(|comments| comments.get(SERATO_MARKERS2_FLAC_KEY))
                .map(str::to_string),
            comments
                .and_then(|comments| comments.get("BPM"))
                .map(str::to_string),
        )
    } else {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let tagged = VorbisFile::read_from(&mut file, ParseOptions::default())
            .map_err(|error| format!("cannot read Ogg metadata: {error}"))?;
        let comments = tagged.vorbis_comments();
        (
            comments.get(SERATO_MARKERS2_OGG_KEY).map(str::to_string),
            comments.get("BPM").map(str::to_string),
        )
    };
    let markers2 = marker_value
        .map(|value| {
            let content = if flac {
                decode_markers2_envelope(&value, MARKERS2_DESCRIPTION)?
            } else {
                decode_serato_base64(value.as_bytes())?
            };
            if flac {
                parse_container_markers2(&content)
            } else {
                parse_markers2_content(&content)
            }
        })
        .transpose()?;
    let bpm = bpm_value
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| (20.0..=300.0).contains(value));
    let markers_present = marker_sources_present(None, markers2.as_ref());
    let metadata = merge_marker_sources(None, markers2.as_ref(), bpm)?;
    Ok(ReadAudioMetadata {
        metadata,
        markers_present,
        needs_wave_id3_normalization: false,
    })
}

fn read_mp4_audio_file(path: &Path) -> Result<ReadAudioMetadata, String> {
    let tag = Mp4Tag::read_from_path(path)
        .map_err(|error| format!("cannot read MP4/M4A metadata: {error}"))?;
    let legacy_ident = Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS_NAME);
    let markers = tag
        .userdata
        .data_of(&legacy_ident)
        .find_map(|value| value.string())
        .map(|value| decode_markers2_envelope(value, MARKERS_DESCRIPTION))
        .transpose()?
        .map(|content| parse_markers_mp4(&content))
        .transpose()?;
    let markers2_ident = Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS2_NAME);
    let markers2_value = tag
        .userdata
        .data_of(&markers2_ident)
        .find_map(|value| value.string())
        .map(|value| {
            let content = decode_markers2_envelope(value, MARKERS2_DESCRIPTION)?;
            parse_container_markers2(&content)
        });
    let markers2 = match markers2_value {
        Some(Ok(markers2)) => Some(markers2),
        Some(Err(_)) if markers.is_some() => None,
        Some(Err(error)) => return Err(error),
        None => None,
    };
    let bpm = tag
        .userdata
        .bpm()
        .map(f64::from)
        .filter(|value| (20.0..=300.0).contains(value));
    let markers_present = marker_sources_present(markers.as_ref(), markers2.as_ref());
    let metadata = merge_marker_sources(markers.as_ref(), markers2.as_ref(), bpm)?;
    Ok(ReadAudioMetadata {
        metadata,
        markers_present,
        needs_wave_id3_normalization: false,
    })
}

fn marker_sources_present(
    markers: Option<&ExistingMarkers>,
    markers2: Option<&ExistingMarkers2>,
) -> bool {
    markers.is_some()
        || markers2.is_some_and(|markers| {
            markers
                .entries
                .iter()
                .any(|entry| matches!(entry.name.as_str(), "CUE" | "LOOP"))
        })
}

/// Update managed CUEs without changing audio samples or an external source
/// file. Existing Serato saved-loop records remain untouched.
pub(super) fn write_audio_file(
    path: &Path,
    metadata: &SeratoMetadata,
    duration_ms: i64,
) -> Result<(), String> {
    let container = check_supported_path(path)?;

    let temporary = copy_to_temporary_file(path)?;
    let result = update_temporary_file(&temporary, path, container, metadata, duration_ms);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn write_extracted_audio_tags(
    path: &Path,
    artist: Option<&str>,
    album: &str,
    cover_image: Option<&[u8]>,
) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp3" | "wav") {
        return Err(format!(
            "cannot tag extracted .{extension} audio with ID3 metadata"
        ));
    }
    if album.trim().is_empty() {
        return Err("looper name for album tag is empty".to_string());
    }
    let picture = cover_image
        .map(|data| {
            if data.len() > 10 * 1024 * 1024 {
                return Err("looper cover exceeds the 10 MiB tag limit".to_string());
            }
            let mime_type = match image::guess_format(data)
                .map_err(|error| format!("cannot identify looper cover image: {error}"))?
            {
                image::ImageFormat::Jpeg => "image/jpeg",
                image::ImageFormat::Png => "image/png",
                _ => return Err("looper cover must be a JPEG or PNG image".to_string()),
            };
            Ok(Picture {
                mime_type: mime_type.to_string(),
                picture_type: PictureType::CoverFront,
                description: "Cover".to_string(),
                data: data.to_vec(),
            })
        })
        .transpose()?;

    let temporary = copy_to_temporary_file(path)?;
    let result = (|| -> Result<(), String> {
        let mut tag = read_audio_tag(&temporary)?.tag;
        tag.set_album(album.trim());
        if let Some(artist) = artist.map(str::trim).filter(|artist| !artist.is_empty()) {
            tag.set_artist(artist);
        }
        if let Some(picture) = picture.clone() {
            tag.remove_picture_by_type(PictureType::CoverFront);
            tag.add_frame(picture);
        }
        write_audio_tag(&temporary, &tag)?;

        let verified = read_audio_tag(&temporary)?.tag;
        if verified.album() != Some(album.trim()) {
            return Err("written looper album tag did not round-trip".to_string());
        }
        if let Some(artist) = artist.map(str::trim).filter(|artist| !artist.is_empty()) {
            if verified.artist() != Some(artist) {
                return Err("written looper artist tag did not round-trip".to_string());
            }
        }
        if picture
            .as_ref()
            .is_some_and(|picture| !verified.pictures().any(|stored| stored == picture))
        {
            return Err("written looper cover tag did not round-trip".to_string());
        }
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn copy_to_temporary_file(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "audio file has no parent directory".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("track");
    let (temporary, mut output) = (1..10_000)
        .find_map(|_| {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let candidate = parent.join(format!(
                ".{name}.serato-{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .ok_or_else(|| "cannot allocate temporary Serato metadata file".to_string())?
        .map_err(|error| format!("cannot create temporary Serato metadata file: {error}"))?;

    let copy_result = (|| -> Result<(), String> {
        let mut source =
            File::open(path).map_err(|error| format!("cannot read audio file: {error}"))?;
        io::copy(&mut source, &mut output)
            .map_err(|error| format!("cannot copy audio for Serato metadata: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("cannot flush temporary audio file: {error}"))?;
        Ok(())
    })();
    drop(output);
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(temporary)
}

fn update_temporary_file(
    temporary: &Path,
    destination: &Path,
    container: MarkerContainer,
    metadata: &SeratoMetadata,
    duration_ms: i64,
) -> Result<(), String> {
    match container {
        MarkerContainer::Id3 => {
            update_id3_temporary_file(temporary, destination, metadata, duration_ms)
        }
        MarkerContainer::Flac => {
            update_vorbis_temporary_file(temporary, destination, metadata, duration_ms, true)
        }
        MarkerContainer::Ogg => {
            update_vorbis_temporary_file(temporary, destination, metadata, duration_ms, false)
        }
        MarkerContainer::Mp4 => {
            update_mp4_temporary_file(temporary, destination, metadata, duration_ms)
        }
    }
}

fn update_id3_temporary_file(
    temporary: &Path,
    destination: &Path,
    metadata: &SeratoMetadata,
    duration_ms: i64,
) -> Result<(), String> {
    let mut tag = read_audio_tag(temporary)?.tag;
    let previous = tag
        .encapsulated_objects()
        .find(|object| object.description == MARKERS_DESCRIPTION)
        .map(|object| object.data.clone());
    let markers = build_markers(metadata, duration_ms, previous.as_deref())?;
    if let Some(bpm) = metadata.bpm {
        if !(20.0..=300.0).contains(&bpm) {
            return Err("BPM is outside the supported range".to_string());
        }
        tag.set_text("TBPM", bpm.to_string());
    }

    tag.remove_encapsulated_object(Some(MARKERS_DESCRIPTION), None, None, None);
    tag.add_frame(EncapsulatedObject {
        mime_type: "application/octet-stream".to_string(),
        filename: String::new(),
        description: MARKERS_DESCRIPTION.to_string(),
        data: markers.clone(),
    });
    write_audio_tag(temporary, &tag)?;

    let verification = read_audio_tag(temporary)?.tag;
    let verified = verification
        .encapsulated_objects()
        .find(|object| object.description == MARKERS_DESCRIPTION)
        .ok_or_else(|| "written Serato cue metadata is missing".to_string())?;
    if verified.data != markers {
        return Err("written Serato cue metadata did not round-trip".to_string());
    }
    parse_markers(&verified.data)?;
    if let Some(bpm) = metadata.bpm {
        let written_bpm = verification
            .get("TBPM")
            .and_then(|frame| frame.content().text())
            .and_then(|text| text.parse::<f64>().ok());
        if written_bpm != Some(bpm) {
            return Err("written BPM metadata did not round-trip".to_string());
        }
    }
    replace_file(temporary, destination)
}

fn previous_markers2_from_comment(
    value: Option<&str>,
    enveloped: bool,
) -> Result<Option<Vec<u8>>, String> {
    value
        .map(|value| {
            let content = decode_marker2_comment(value, enveloped)?;
            if enveloped {
                container_markers2_to_id3(&content)
            } else {
                id3_markers2_from_content(&content)
            }
        })
        .transpose()
}

fn build_vorbis_marker_comment(
    metadata: &SeratoMetadata,
    duration_ms: i64,
    previous_value: Option<&str>,
    enveloped: bool,
) -> Result<String, String> {
    let previous = previous_markers2_from_comment(previous_value, enveloped)?;
    let marker_tag = build_markers2(metadata, duration_ms, previous.as_deref())?;
    let content = if enveloped {
        marker_tag
    } else {
        markers2_content_from_id3(&marker_tag)?
    };
    Ok(encode_marker2_comment(&content, enveloped))
}

fn update_vorbis_temporary_file(
    temporary: &Path,
    destination: &Path,
    metadata: &SeratoMetadata,
    duration_ms: i64,
    flac: bool,
) -> Result<(), String> {
    if let Some(bpm) = metadata.bpm {
        if !(20.0..=300.0).contains(&bpm) {
            return Err("BPM is outside the supported range".to_string());
        }
    }
    if flac {
        let mut file = File::open(temporary).map_err(|error| error.to_string())?;
        let mut audio = FlacFile::read_from(&mut file, ParseOptions::default())
            .map_err(|error| format!("cannot read FLAC metadata: {error}"))?;
        let previous = audio
            .vorbis_comments()
            .and_then(|comments| comments.get(SERATO_MARKERS2_FLAC_KEY))
            .map(str::to_string);
        let marker_value =
            build_vorbis_marker_comment(metadata, duration_ms, previous.as_deref(), true)?;
        if audio.vorbis_comments().is_none() {
            audio.set_vorbis_comments(VorbisComments::new());
        }
        let comments = audio
            .vorbis_comments_mut()
            .ok_or("cannot create FLAC Vorbis comments")?;
        comments.insert(SERATO_MARKERS2_FLAC_KEY.to_string(), marker_value);
        if let Some(bpm) = metadata.bpm {
            comments.insert("BPM".to_string(), bpm.to_string());
        }
        audio
            .save_to_path(temporary, WriteOptions::default())
            .map_err(|error| format!("cannot write FLAC Serato markers: {error}"))?;
    } else {
        let mut file = File::open(temporary).map_err(|error| error.to_string())?;
        let mut audio = VorbisFile::read_from(&mut file, ParseOptions::default())
            .map_err(|error| format!("cannot read Ogg metadata: {error}"))?;
        let previous = audio
            .vorbis_comments()
            .get(SERATO_MARKERS2_OGG_KEY)
            .map(str::to_string);
        let marker_value =
            build_vorbis_marker_comment(metadata, duration_ms, previous.as_deref(), false)?;
        let comments = audio.vorbis_comments_mut();
        comments.insert(SERATO_MARKERS2_OGG_KEY.to_string(), marker_value);
        if let Some(bpm) = metadata.bpm {
            comments.insert("BPM".to_string(), bpm.to_string());
        }
        audio
            .save_to_path(temporary, WriteOptions::default())
            .map_err(|error| format!("cannot write Ogg Serato markers: {error}"))?;
    }

    verify_marker_metadata(
        temporary,
        metadata,
        duration_ms,
        if flac {
            MarkerContainer::Flac
        } else {
            MarkerContainer::Ogg
        },
    )?;
    replace_file(temporary, destination)
}

fn update_mp4_temporary_file(
    temporary: &Path,
    destination: &Path,
    metadata: &SeratoMetadata,
    duration_ms: i64,
) -> Result<(), String> {
    if let Some(bpm) = metadata.bpm {
        if !(20.0..=300.0).contains(&bpm) {
            return Err("BPM is outside the supported range".to_string());
        }
    }
    let mut tag = Mp4Tag::read_from_path(temporary)
        .map_err(|error| format!("cannot read MP4/M4A metadata: {error}"))?;
    let markers_ident = Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS_NAME);
    let previous = tag
        .userdata
        .data_of(&markers_ident)
        .find_map(|data| data.string())
        .map(|value| {
            let content = decode_markers2_envelope(value, MARKERS_DESCRIPTION)?;
            parse_markers_mp4(&content)
        })
        .transpose()?;
    let previous_markers = previous.as_ref().map(serialize_existing_markers);
    let footer = previous
        .as_ref()
        .and_then(|markers| markers.mp4_footer)
        .unwrap_or(0);
    let markers = build_markers(metadata, duration_ms, previous_markers.as_deref())?;
    let mut marker_data = build_markers_mp4(&markers)?;
    *marker_data
        .last_mut()
        .ok_or("MP4 Serato marker footer is missing")? = footer;

    let markers2_ident = Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS2_NAME);
    let has_markers2 = tag.userdata.data_of(&markers2_ident).next().is_some();
    let marker_value = encode_markers2_envelope(&marker_data, MARKERS_DESCRIPTION);

    tag.userdata.take_data_of(&markers_ident).for_each(drop);
    tag.userdata
        .add_data(markers_ident, Mp4Data::Utf8(marker_value));
    if !has_markers2 {
        let markers2 = build_markers2(metadata, duration_ms, None)?;
        tag.userdata.add_data(
            markers2_ident,
            Mp4Data::Utf8(encode_markers2_envelope(&markers2, MARKERS2_DESCRIPTION)),
        );
    }
    if let Some(bpm) = metadata.bpm {
        tag.userdata.set_bpm(bpm.round().clamp(20.0, 300.0) as u16);
    }
    tag.write_to_path(temporary)
        .map_err(|error| format!("cannot write MP4/M4A Serato markers: {error}"))?;

    verify_marker_metadata(temporary, metadata, duration_ms, MarkerContainer::Mp4)?;
    replace_file(temporary, destination)
}

fn verify_marker_metadata(
    path: &Path,
    expected: &SeratoMetadata,
    duration_ms: i64,
    container: MarkerContainer,
) -> Result<(), String> {
    let read = match container {
        MarkerContainer::Flac => read_vorbis_audio_file(path, true)?,
        MarkerContainer::Ogg => read_vorbis_audio_file(path, false)?,
        MarkerContainer::Mp4 => read_mp4_audio_file(path)?,
        MarkerContainer::Id3 => read_id3_audio_file(path)?,
    };
    let mut expected_cues = expected
        .cues
        .iter()
        .filter(|cue| (1..=APP_CUE_COUNT as i64).contains(&cue.slot))
        .map(|cue| (cue.slot, if cue.slot == 1 { 0 } else { cue.position_ms }))
        .collect::<Vec<_>>();
    expected_cues.retain(|(slot, _)| *slot != 1);
    expected_cues.push((1, 0));
    expected_cues.sort_unstable();
    let mut actual_cues = read
        .metadata
        .cues
        .iter()
        .map(|cue| (cue.slot, cue.position_ms))
        .collect::<Vec<_>>();
    actual_cues.sort_unstable();
    if expected_cues != actual_cues {
        return Err(format!(
            "Serato markers did not round-trip for a {duration_ms} ms track"
        ));
    }
    Ok(())
}

fn build_markers(
    metadata: &SeratoMetadata,
    duration_ms: i64,
    previous: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if duration_ms < 0 {
        return Err("track duration is invalid".to_string());
    }
    let old = previous.map(parse_markers).transpose()?.unwrap_or_default();
    let mut cue_entries = Vec::with_capacity(LEGACY_CUE_COUNT);
    for slot in 1..=LEGACY_CUE_COUNT {
        if slot > APP_CUE_COUNT {
            cue_entries.push(
                old.cues
                    .get(slot - 1)
                    .cloned()
                    .unwrap_or(marker_entry(None, None, 0x00CC00, 0, false)?),
            );
            continue;
        }
        let cue = metadata.cues.iter().find(|cue| cue.slot == slot as i64);
        let position = if slot == 1 {
            Some(0)
        } else {
            cue.map(|cue| cue.position_ms)
        };
        if let Some(position) = position {
            validate_position(position, duration_ms)?;
        }
        cue_entries.push(marker_entry(
            position,
            None,
            CUE_COLORS[slot - 1],
            if position.is_some() { 1 } else { 0 },
            false,
        )?);
    }

    // oLooper does not manage saved loops. Preserve existing Serato loop
    // entries byte-for-byte and fill only absent legacy positions.
    let mut loop_entries = old.loops.clone();
    while loop_entries.len() < LEGACY_LOOP_COUNT {
        loop_entries.push(marker_entry(None, None, LOOP_COLOR, 3, false)?);
    }
    loop_entries.truncate(LEGACY_LOOP_COUNT);

    let mut entries = cue_entries;
    entries.extend(loop_entries);
    entries.extend(old.other);

    let track_color = old.track_color.unwrap_or_else(|| serato32(0xFFFFFF));
    let mut output = Vec::with_capacity(10 + entries.len() * MARKER_BYTES);
    output.extend_from_slice(&old.version.unwrap_or([2, 5]));
    output.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for entry in entries {
        output.extend_from_slice(&entry);
    }
    output.extend_from_slice(&track_color);
    Ok(output)
}

fn build_markers2(
    metadata: &SeratoMetadata,
    duration_ms: i64,
    previous: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let old = previous
        .map(parse_markers2)
        .transpose()?
        .unwrap_or_default();
    let mut entries = old
        .entries
        .into_iter()
        .filter(|entry| {
            entry.name != "CUE"
                || entry
                    .index
                    .is_some_and(|index| index as usize >= APP_CUE_COUNT)
        })
        .map(|entry| entry.raw)
        .collect::<Vec<_>>();

    if !metadata.cues.iter().any(|cue| cue.slot == 1) {
        entries.push(markers2_cue_entry(&SeratoCue {
            slot: 1,
            label: cue_label(1),
            position_ms: 0,
        })?);
    }
    for cue in &metadata.cues {
        if !(1..=APP_CUE_COUNT as i64).contains(&cue.slot) {
            return Err("CUE slot must be between 1 and 4".to_string());
        }
        let mut cue = cue.clone();
        if cue.slot == 1 {
            cue.position_ms = 0;
        }
        validate_position(cue.position_ms, duration_ms)?;
        entries.push(markers2_cue_entry(&cue)?);
    }
    Ok(encode_markers2(
        old.outer_version.unwrap_or([1, 1]),
        old.content_version.unwrap_or([1, 1]),
        &entries,
    ))
}

fn markers2_cue_entry(cue: &SeratoCue) -> Result<Vec<u8>, String> {
    let index = u8::try_from(cue.slot - 1).map_err(|_| "invalid CUE slot")?;
    let label = cue.label.as_bytes();
    if label.len() > 50 || label.contains(&0) {
        return Err("CUE label is invalid".to_string());
    }
    let color = CUE_COLORS[index as usize];
    let mut data = vec![0, index];
    data.extend_from_slice(&(cue.position_ms as u32).to_be_bytes());
    data.push(0);
    data.extend_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, color as u8]);
    data.extend_from_slice(&[0, 0]);
    data.extend_from_slice(label);
    data.push(0);
    Ok(markers2_entry("CUE", data))
}

fn markers2_entry(name: &str, data: Vec<u8>) -> Vec<u8> {
    let mut entry = Vec::with_capacity(name.len() + 5 + data.len());
    entry.extend_from_slice(name.as_bytes());
    entry.push(0);
    entry.extend_from_slice(&(data.len() as u32).to_be_bytes());
    entry.extend_from_slice(&data);
    entry
}

fn encode_markers2(
    outer_version: [u8; 2],
    content_version: [u8; 2],
    entries: &[Vec<u8>],
) -> Vec<u8> {
    let mut content = Vec::new();
    content.extend_from_slice(&content_version);
    for entry in entries {
        content.extend_from_slice(entry);
    }
    let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(content);
    let mut output = Vec::with_capacity(MARKERS2_MINIMUM_SIZE.max(encoded.len() + 2));
    output.extend_from_slice(&outer_version);
    for chunk in encoded.as_bytes().chunks(72) {
        output.extend_from_slice(chunk);
        if chunk.len() == 72 {
            output.push(b'\n');
        }
    }
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    output.resize(output.len().max(MARKERS2_MINIMUM_SIZE), 0);
    output
}

fn merge_marker_sources(
    markers: Option<&ExistingMarkers>,
    markers2: Option<&ExistingMarkers2>,
    bpm: Option<f64>,
) -> Result<SeratoMetadata, String> {
    let mut cues = std::collections::BTreeMap::<i64, SeratoCue>::new();
    let mut loops = std::collections::BTreeMap::<i64, SeratoLoop>::new();

    if let Some(markers2) = markers2 {
        for entry in &markers2.entries {
            match entry.name.as_str() {
                "CUE" => {
                    if let Some(cue) = parse_markers2_cue(&entry.raw)? {
                        cues.insert(cue.slot, cue);
                    }
                }
                "LOOP" => {
                    if let Some(saved) = parse_markers2_loop(&entry.raw)? {
                        loops.insert(saved.slot, saved);
                    }
                }
                _ => {}
            }
        }
    }

    // Serato gives Markers_ precedence for its first five cues and nine loops.
    if let Some(markers) = markers {
        for (index, entry) in markers.cues.iter().take(APP_CUE_COUNT).enumerate() {
            let slot = index as i64 + 1;
            if entry[20] == 1 {
                let Some(position_ms) = parse_marker_position(&entry[..5])? else {
                    cues.remove(&slot);
                    continue;
                };
                let label = cues
                    .get(&slot)
                    .map(|cue| cue.label.clone())
                    .unwrap_or_else(|| cue_label(slot));
                cues.insert(
                    slot,
                    SeratoCue {
                        slot,
                        label,
                        position_ms,
                    },
                );
            } else {
                cues.remove(&slot);
            }
        }
        for (index, entry) in markers.loops.iter().take(APP_LOOP_COUNT).enumerate() {
            let slot = index as i64 + 1;
            let start_ms = parse_marker_position(&entry[..5])?;
            let end_ms = parse_marker_position(&entry[5..10])?;
            if let (Some(start_ms), Some(end_ms)) = (start_ms, end_ms) {
                let label = loops
                    .get(&slot)
                    .map(|saved| saved.label.clone())
                    .unwrap_or_else(|| loop_label(slot));
                loops.insert(
                    slot,
                    SeratoLoop {
                        slot,
                        label,
                        start_ms,
                        end_ms,
                    },
                );
            } else {
                loops.remove(&slot);
            }
        }
    }

    Ok(SeratoMetadata {
        cues: cues.into_values().collect(),
        loops: loops.into_values().collect(),
        bpm,
    })
}

fn cue_label(slot: i64) -> String {
    char::from(b'A' + (slot.saturating_sub(1) as u8)).to_string()
}

fn loop_label(slot: i64) -> String {
    format!("Loop {slot}")
}

fn parse_markers2(data: &[u8]) -> Result<ExistingMarkers2, String> {
    if data.len() < 2 || data.len() > MARKERS2_MINIMUM_SIZE.max(MAX_MARKERS2_BYTES) {
        return Err("existing Serato Markers2 metadata has an invalid size".to_string());
    }
    let outer_version = [data[0], data[1]];
    let encoded = data[2..]
        .split(|byte| *byte == 0)
        .next()
        .unwrap_or_default();
    if encoded.is_empty() {
        return Ok(ExistingMarkers2 {
            outer_version: Some(outer_version),
            ..ExistingMarkers2::default()
        });
    }
    let content = decode_serato_base64(encoded)?;
    let mut parsed = parse_markers2_content(&content)?;
    parsed.outer_version = Some(outer_version);
    Ok(parsed)
}

fn parse_markers2_content(content: &[u8]) -> Result<ExistingMarkers2, String> {
    if content.len() < 2 {
        return Err("Serato Markers2 content is truncated".to_string());
    }
    let mut parsed = ExistingMarkers2 {
        content_version: Some([content[0], content[1]]),
        ..ExistingMarkers2::default()
    };
    let mut offset = 2usize;
    while offset < content.len() {
        if content[offset..].iter().all(|byte| *byte == 0) {
            break;
        }
        if parsed.entries.len() >= 512 {
            return Err("Serato Markers2 metadata has too many entries".to_string());
        }
        let name_end = content[offset..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|position| offset + position)
            .ok_or("Serato Markers2 marker name is unterminated")?;
        if name_end == offset || name_end - offset > 32 {
            return Err("Serato Markers2 marker name is invalid".to_string());
        }
        let name = std::str::from_utf8(&content[offset..name_end])
            .map_err(|_| "Serato Markers2 marker name is not UTF-8")?
            .to_string();
        let length_offset = name_end + 1;
        let data_start = length_offset.checked_add(4).ok_or("invalid marker size")?;
        if data_start > content.len() {
            return Err("Serato Markers2 marker header is truncated".to_string());
        }
        let length =
            u32::from_be_bytes(content[length_offset..data_start].try_into().unwrap()) as usize;
        if length > MAX_MARKERS2_BYTES {
            return Err("Serato Markers2 marker is too large".to_string());
        }
        let entry_end = data_start
            .checked_add(length)
            .ok_or("invalid marker size")?;
        if entry_end > content.len() {
            return Err("Serato Markers2 marker data is truncated".to_string());
        }
        let marker_data = &content[data_start..entry_end];
        let index = match name.as_str() {
            "CUE" | "LOOP" if marker_data.len() >= 2 && marker_data[0] == 0 => Some(marker_data[1]),
            _ => None,
        };
        parsed.entries.push(Markers2Entry {
            name,
            index,
            raw: content[offset..entry_end].to_vec(),
        });
        offset = entry_end;
    }
    Ok(parsed)
}

fn decode_serato_base64(encoded: &[u8]) -> Result<Vec<u8>, String> {
    let mut clean = encoded
        .iter()
        .copied()
        .filter(|byte| !matches!(*byte, b'\n' | b'\r' | b' ' | b'\t'))
        .collect::<Vec<_>>();
    while clean.last() == Some(&b'=') {
        clean.pop();
    }
    if clean.len() % 4 == 1 {
        clean.push(b'A');
    }
    match base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean) {
        Ok(content) => Ok(content),
        Err(base64::DecodeError::InvalidLastSymbol(_, _)) => {
            // Serato sometimes writes non-canonical trailing bits in an
            // unpadded envelope. Parse the validated binary marker records
            // after decoding rather than rejecting an otherwise valid tag.
            const SERATO_BASE64: base64::engine::general_purpose::GeneralPurpose =
                base64::engine::general_purpose::GeneralPurpose::new(
                    &base64::alphabet::STANDARD,
                    base64::engine::general_purpose::GeneralPurposeConfig::new()
                        .with_encode_padding(false)
                        .with_decode_allow_trailing_bits(true),
                );
            SERATO_BASE64
                .decode(clean)
                .map_err(|error| format!("cannot decode Serato marker tag: {error}"))
        }
        Err(error) => Err(format!("cannot decode Serato marker tag: {error}")),
    }
}

fn encode_serato_base64(data: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(data);
    encoded
        .as_bytes()
        .chunks(72)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

fn markers2_content_from_id3(data: &[u8]) -> Result<Vec<u8>, String> {
    let parsed = parse_markers2(data)?;
    let version = parsed.content_version.unwrap_or([1, 1]);
    let mut content = version.to_vec();
    for entry in parsed.entries {
        content.extend_from_slice(&entry.raw);
    }
    Ok(content)
}

fn id3_markers2_from_content(content: &[u8]) -> Result<Vec<u8>, String> {
    let parsed = parse_markers2_content(content)?;
    let version = parsed.content_version.unwrap_or([1, 1]);
    let entries = parsed
        .entries
        .into_iter()
        .map(|entry| entry.raw)
        .collect::<Vec<_>>();
    Ok(encode_markers2([1, 1], version, &entries))
}

fn parse_container_markers2(payload: &[u8]) -> Result<ExistingMarkers2, String> {
    // Serato's FLAC and MP4 values enclose the *entire* ID3 Markers2
    // payload (two version bytes followed by base64), not decoded entries.
    // Older oLooper builds mistakenly stored the decoded entries directly.
    parse_markers2(payload).or_else(|_| parse_markers2_content(payload))
}

fn container_markers2_to_id3(payload: &[u8]) -> Result<Vec<u8>, String> {
    if parse_markers2(payload).is_ok() {
        Ok(payload.to_vec())
    } else {
        id3_markers2_from_content(payload)
    }
}

fn decode_markers2_envelope(value: &str, expected_name: &str) -> Result<Vec<u8>, String> {
    let decoded = decode_serato_base64(value.as_bytes())?;
    let name_start = if decoded.starts_with(SERATO_ENVELOPE_MIME) {
        SERATO_ENVELOPE_MIME.len()
    } else if decoded.starts_with(b"application/octet-stream\0") {
        // Read tags emitted by earlier oLooper versions with one separator.
        b"application/octet-stream\0".len()
    } else {
        return Err("Serato marker envelope has an invalid MIME header".to_string());
    };
    let name_end = decoded[name_start..]
        .iter()
        .position(|byte| *byte == 0)
        .map(|position| name_start + position)
        .ok_or("Serato marker envelope name is unterminated")?;
    let name = std::str::from_utf8(&decoded[name_start..name_end])
        .map_err(|_| "Serato marker envelope name is invalid")?;
    if name != expected_name {
        return Err(format!("unexpected Serato marker envelope '{name}'"));
    }
    Ok(decoded[name_end + 1..].to_vec())
}

fn encode_markers2_envelope(content: &[u8], name: &str) -> String {
    let mut envelope =
        Vec::with_capacity(SERATO_ENVELOPE_MIME.len() + name.len() + 1 + content.len());
    envelope.extend_from_slice(SERATO_ENVELOPE_MIME);
    envelope.extend_from_slice(name.as_bytes());
    envelope.push(0);
    envelope.extend_from_slice(content);
    encode_serato_base64(&envelope)
}

fn encode_marker2_comment(content: &[u8], enveloped: bool) -> String {
    if enveloped {
        encode_markers2_envelope(content, MARKERS2_DESCRIPTION)
    } else {
        encode_serato_base64(content)
    }
}

fn decode_marker2_comment(value: &str, enveloped: bool) -> Result<Vec<u8>, String> {
    if enveloped {
        decode_markers2_envelope(value, MARKERS2_DESCRIPTION)
    } else {
        decode_serato_base64(value.as_bytes())
    }
}

fn parse_markers2_cue(raw: &[u8]) -> Result<Option<SeratoCue>, String> {
    let data = markers2_data(raw)?;
    if data.len() < 13 || data[0] != 0 || data[6] != 0 || data[10..12] != [0, 0] {
        return Err("Serato Markers2 CUE entry is malformed".to_string());
    }
    let label = parse_marker2_label(&data[12..])?;
    let slot = data[1] as i64 + 1;
    Ok((slot <= APP_CUE_COUNT as i64).then_some(SeratoCue {
        slot,
        label: if label.is_empty() {
            cue_label(slot)
        } else {
            label
        },
        position_ms: u32::from_be_bytes(data[2..6].try_into().unwrap()) as i64,
    }))
}

fn parse_markers2_loop(raw: &[u8]) -> Result<Option<SeratoLoop>, String> {
    let data = markers2_data(raw)?;
    if data.len() < 21
        || data[0] != 0
        || data[10..14] != [0xff; 4]
        || data[14] != 0
        || data[18] != 0
    {
        return Err("Serato Markers2 saved-loop entry is malformed".to_string());
    }
    let label = parse_marker2_label(&data[20..])?;
    let slot = data[1] as i64 + 1;
    Ok((slot <= APP_LOOP_COUNT as i64).then_some(SeratoLoop {
        slot,
        label: if label.is_empty() {
            loop_label(slot)
        } else {
            label
        },
        start_ms: u32::from_be_bytes(data[2..6].try_into().unwrap()) as i64,
        end_ms: u32::from_be_bytes(data[6..10].try_into().unwrap()) as i64,
    }))
}

fn markers2_data(raw: &[u8]) -> Result<&[u8], String> {
    let name_end = raw
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("Serato Markers2 marker name is unterminated")?;
    let length_offset = name_end + 1;
    let data_start = length_offset + 4;
    if data_start > raw.len() {
        return Err("Serato Markers2 marker header is truncated".to_string());
    }
    let length = u32::from_be_bytes(raw[length_offset..data_start].try_into().unwrap()) as usize;
    let data_end = data_start
        .checked_add(length)
        .ok_or("invalid marker size")?;
    if data_end != raw.len() {
        return Err("Serato Markers2 marker size does not match".to_string());
    }
    Ok(&raw[data_start..data_end])
}

fn parse_marker2_label(data: &[u8]) -> Result<String, String> {
    let end = data
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("Serato Markers2 label is not terminated")?;
    std::str::from_utf8(&data[..end])
        .map(str::to_string)
        .map_err(|_| "Serato Markers2 label is not valid UTF-8".to_string())
}

fn validate_position(position: i64, duration_ms: i64) -> Result<u32, String> {
    if position < 0 || position > duration_ms || position > MAX_SERATO_POSITION_MS {
        return Err(
            "a saved CUE or loop boundary is outside the Serato-supported range".to_string(),
        );
    }
    Ok(position as u32)
}

fn marker_entry(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    color: u32,
    marker_type: u8,
    locked: bool,
) -> Result<Vec<u8>, String> {
    let mut entry = Vec::with_capacity(MARKER_BYTES);
    entry.extend_from_slice(&serato_position(start_ms)?);
    entry.extend_from_slice(&serato_position(end_ms)?);
    entry.extend_from_slice(b"\0\x7f\x7f\x7f\x7f\x7f");
    entry.extend_from_slice(&serato32(color));
    entry.push(marker_type);
    entry.push(u8::from(locked));
    debug_assert_eq!(entry.len(), MARKER_BYTES);
    Ok(entry)
}

fn serato_position(position_ms: Option<i64>) -> Result<[u8; 5], String> {
    match position_ms {
        Some(position) => {
            let value = validate_position(position, i64::MAX)?;
            let encoded = serato32(value);
            Ok([0, encoded[0], encoded[1], encoded[2], encoded[3]])
        }
        None => Ok([0x7f; 5]),
    }
}

fn serato32(value: u32) -> [u8; 4] {
    let first = ((value >> 16) & 0xff) as u8;
    let second = ((value >> 8) & 0xff) as u8;
    let third = (value & 0xff) as u8;
    [
        first >> 5,
        ((second >> 6) | (first << 2)) & 0x7f,
        ((third >> 7) | (second << 1)) & 0x7f,
        third & 0x7f,
    ]
}

fn decode_serato32(bytes: &[u8]) -> Result<u32, String> {
    if bytes.len() != 4 || bytes.iter().any(|byte| *byte > 0x7f) {
        return Err("Serato position has an invalid encoding".to_string());
    }
    let first = ((bytes[0] & 0x07) << 5) | ((bytes[1] >> 2) & 0x1f);
    let second = ((bytes[1] & 0x03) << 6) | ((bytes[2] >> 1) & 0x3f);
    let third = ((bytes[2] & 0x01) << 7) | bytes[3];
    Ok(u32::from_be_bytes([0, first, second, third]))
}

fn parse_marker_position(bytes: &[u8]) -> Result<Option<i64>, String> {
    if bytes.len() != 5 {
        return Err("Serato marker position is truncated".to_string());
    }
    if bytes == [0x7f; 5] {
        return Ok(None);
    }
    if bytes[0] != 0 {
        return Err("Serato marker position has an invalid prefix".to_string());
    }
    Ok(Some(decode_serato32(&bytes[1..])? as i64))
}

fn parse_markers(data: &[u8]) -> Result<ExistingMarkers, String> {
    if data.len() < 10 {
        return Err("existing Serato marker metadata is truncated".to_string());
    }
    let count = u32::from_be_bytes(data[2..6].try_into().unwrap()) as usize;
    if count > 64 {
        return Err("existing Serato marker metadata has too many entries".to_string());
    }
    let expected = 10usize
        .checked_add(
            count
                .checked_mul(MARKER_BYTES)
                .ok_or("invalid marker count")?,
        )
        .ok_or("invalid marker count")?;
    if data.len() != expected {
        return Err("existing Serato marker metadata has an invalid size".to_string());
    }
    let mut parsed = ExistingMarkers {
        version: Some([data[0], data[1]]),
        track_color: Some(data[expected - 4..expected].try_into().unwrap()),
        ..ExistingMarkers::default()
    };
    for entry in data[6..expected - 4].chunks_exact(MARKER_BYTES) {
        let entry = entry.to_vec();
        match entry[20] {
            0 | 1 => parsed.cues.push(entry),
            3 => parsed.loops.push(entry),
            _ => parsed.other.push(entry),
        }
    }
    Ok(parsed)
}

fn parse_markers_mp4(data: &[u8]) -> Result<ExistingMarkers, String> {
    const MP4_MARKER_BYTES: usize = 19;
    if data.len() < 11 {
        return Err("existing MP4 Serato Markers_ metadata is truncated".to_string());
    }
    let count = u32::from_be_bytes(data[2..6].try_into().unwrap()) as usize;
    if count > 64 {
        return Err("existing MP4 Serato Markers_ has too many entries".to_string());
    }
    let expected = 11usize
        .checked_add(
            count
                .checked_mul(MP4_MARKER_BYTES)
                .ok_or("invalid marker count")?,
        )
        .ok_or("invalid marker count")?;
    if data.len() != expected || data[expected - 5] != 0 {
        return Err("existing MP4 Serato Markers_ has an invalid size".to_string());
    }
    let track_rgb = &data[expected - 4..expected - 1];
    let mut parsed = ExistingMarkers {
        version: Some([data[0], data[1]]),
        track_color: Some(serato32(u32::from_be_bytes([
            0,
            track_rgb[0],
            track_rgb[1],
            track_rgb[2],
        ]))),
        mp4_footer: Some(data[expected - 1]),
        ..ExistingMarkers::default()
    };
    for raw in data[6..expected - 5].chunks_exact(MP4_MARKER_BYTES) {
        let start = u32::from_be_bytes(raw[..4].try_into().unwrap());
        let end = u32::from_be_bytes(raw[4..8].try_into().unwrap());
        let marker_type = raw[17];
        let locked = raw[18] != 0;
        let position =
            (start != u32::MAX && start <= MAX_SERATO_POSITION_MS as u32).then_some(start as i64);
        let end_position =
            (marker_type == 3 && end != u32::MAX && end <= MAX_SERATO_POSITION_MS as u32)
                .then_some(end as i64);
        let color = u32::from_be_bytes([0, raw[14], raw[15], raw[16]]);
        let entry = marker_entry(position, end_position, color, marker_type, locked)?;
        match marker_type {
            0 | 1 => parsed.cues.push(entry),
            3 => parsed.loops.push(entry),
            _ => parsed.other.push(entry),
        }
    }
    Ok(parsed)
}

fn serialize_existing_markers(markers: &ExistingMarkers) -> Vec<u8> {
    let entries = markers
        .cues
        .iter()
        .chain(markers.loops.iter())
        .chain(markers.other.iter())
        .collect::<Vec<_>>();
    let mut output = Vec::with_capacity(10 + entries.len() * MARKER_BYTES);
    output.extend_from_slice(&markers.version.unwrap_or([2, 5]));
    output.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for entry in entries {
        output.extend_from_slice(entry);
    }
    output.extend_from_slice(&markers.track_color.unwrap_or_else(|| serato32(0xFFFFFF)));
    output
}

fn build_markers_mp4(id3_data: &[u8]) -> Result<Vec<u8>, String> {
    const MP4_MARKER_BYTES: usize = 19;
    let markers = parse_markers(id3_data)?;
    let entries = markers
        .cues
        .iter()
        .chain(markers.loops.iter())
        .chain(markers.other.iter())
        .collect::<Vec<_>>();
    let mut output = Vec::with_capacity(11 + entries.len() * MP4_MARKER_BYTES);
    output.extend_from_slice(&markers.version.unwrap_or([2, 5]));
    output.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for entry in entries {
        let start = parse_marker_position(&entry[..5])?
            .map(|position| position as u32)
            .unwrap_or(u32::MAX);
        let end = parse_marker_position(&entry[5..10])?
            .map(|position| position as u32)
            .unwrap_or(u32::MAX);
        let color = decode_serato32(&entry[16..20])?;
        output.extend_from_slice(&start.to_be_bytes());
        output.extend_from_slice(&end.to_be_bytes());
        output.extend_from_slice(b"\0\xff\xff\xff\xff\0");
        output.extend_from_slice(&[
            ((color >> 16) & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            (color & 0xff) as u8,
        ]);
        output.push(entry[20]);
        output.push(entry[21]);
    }
    output.push(0);
    let track_color = decode_serato32(&markers.track_color.unwrap_or_else(|| serato32(0xFFFFFF)))?;
    output.extend_from_slice(&[
        ((track_color >> 16) & 0xff) as u8,
        ((track_color >> 8) & 0xff) as u8,
        (track_color & 0xff) as u8,
    ]);
    output.push(0);
    Ok(output)
}

fn replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(temporary, destination)
            .map_err(|error| format!("cannot replace library audio with Serato metadata: {error}"))
    }
    #[cfg(target_os = "windows")]
    {
        let backup = destination.with_extension(format!(
            "serato-backup-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(destination, &backup)
            .map_err(|error| format!("cannot stage library audio for Serato metadata: {error}"))?;
        if let Err(error) = fs::rename(temporary, destination) {
            let _ = fs::rename(&backup, destination);
            return Err(format!(
                "cannot replace library audio with Serato metadata: {error}"
            ));
        }
        fs::remove_file(backup)
            .map_err(|error| format!("Serato metadata synced but backup cleanup failed: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn full_metadata() -> SeratoMetadata {
        SeratoMetadata {
            cues: (1..=4)
                .map(|slot| SeratoCue {
                    slot,
                    label: cue_label(slot),
                    position_ms: if slot == 1 { 0 } else { slot * 100 },
                })
                .collect(),
            loops: Vec::new(),
            bpm: Some(123.5),
        }
    }

    fn wav_data(bytes: &[u8]) -> &[u8] {
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let name = &bytes[offset..offset + 4];
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let start = offset + 8;
            let end = start + length;
            if name == b"data" {
                return &bytes[start..end];
            }
            offset = end + (length % 2);
        }
        panic!("WAV has no data chunk");
    }

    fn wav_id3_chunk_ids(bytes: &[u8]) -> Vec<[u8; 4]> {
        let mut ids = Vec::new();
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let id: [u8; 4] = bytes[offset..offset + 4].try_into().unwrap();
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if id.eq_ignore_ascii_case(b"ID3 ") {
                ids.push(id);
            }
            offset += 8 + size + (size & 1);
        }
        ids
    }

    fn append_wav_chunk(path: &Path, id: [u8; 4], payload: &[u8]) {
        let mut bytes = fs::read(path).unwrap();
        bytes.extend_from_slice(&id);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() & 1 == 1 {
            bytes.push(0);
        }
        let riff_size = (bytes.len() - 8) as u32;
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    fn wav_with_ramp(frames: usize) -> Vec<u8> {
        let data_len = (frames * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for frame in 0..frames {
            bytes.extend_from_slice(&(frame as i16).to_le_bytes());
        }
        bytes
    }

    #[test]
    fn legacy_serato_marker_layout_roundtrips_four_cues_and_default_start() {
        let metadata = full_metadata();
        let legacy = build_markers(&metadata, 1_000, None).unwrap();
        assert_eq!(u32::from_be_bytes(legacy[2..6].try_into().unwrap()), 14);
        let parsed_legacy = parse_markers(&legacy).unwrap();
        assert_eq!(parsed_legacy.cues.len(), LEGACY_CUE_COUNT);
        assert_eq!(parsed_legacy.loops.len(), LEGACY_LOOP_COUNT);
        assert_eq!(parsed_legacy.cues[0][20], 1);
        assert_eq!(
            parse_marker_position(&parsed_legacy.cues[0][..5]).unwrap(),
            Some(0)
        );

        let markers2 = build_markers2(&metadata, 1_000, None).unwrap();
        assert_eq!(&markers2[..2], &[1, 1]);
        assert!(markers2.len() >= MARKERS2_MINIMUM_SIZE);
        let parsed_markers2 = parse_markers2(&markers2).unwrap();
        let merged =
            merge_marker_sources(Some(&parsed_legacy), Some(&parsed_markers2), Some(123.5))
                .unwrap();
        assert_eq!(merged.cues.len(), 4);
        assert!(merged.loops.is_empty());
        assert_eq!(merged.cues[1].position_ms, 200);
        assert_eq!(merged.cues[3].position_ms, 400);
        assert_eq!(merged.bpm, Some(123.5));
    }

    #[test]
    fn changing_a_cue_preserves_serato_saved_loops_and_fixes_cue_one_at_start() {
        let mut original =
            parse_markers(&build_markers(&SeratoMetadata::default(), 1_000, None).unwrap())
                .unwrap();
        original.loops[2] = marker_entry(Some(125), Some(875), LOOP_COLOR, 3, true).unwrap();
        let original_loop = original.loops[2].clone();
        let previous = serialize_existing_markers(&original);
        let edited = SeratoMetadata {
            cues: vec![SeratoCue {
                slot: 2,
                label: "B".into(),
                position_ms: 320,
            }],
            ..SeratoMetadata::default()
        };

        let updated =
            parse_markers(&build_markers(&edited, 1_000, Some(&previous)).unwrap()).unwrap();

        assert_eq!(updated.loops[2], original_loop);
        assert_eq!(
            parse_marker_position(&updated.cues[0][..5]).unwrap(),
            Some(0)
        );
        assert_eq!(
            parse_marker_position(&updated.cues[1][..5]).unwrap(),
            Some(320)
        );
    }

    #[test]
    fn wav_cue_update_keeps_existing_loop_entry_and_markers2_untouched() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("serato-loops.wav");
        fs::write(&path, wav_with_ramp(8_000)).unwrap();
        let mut legacy =
            parse_markers(&build_markers(&full_metadata(), 1_000, None).unwrap()).unwrap();
        legacy.loops[2] = marker_entry(Some(150), Some(750), LOOP_COLOR, 3, true).unwrap();
        let original_loop = legacy.loops[2].clone();
        let original_markers2 = build_markers2(&full_metadata(), 1_000, None).unwrap();
        let mut tag = Tag::new();
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: MARKERS_DESCRIPTION.to_string(),
            data: serialize_existing_markers(&legacy),
        });
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: MARKERS2_DESCRIPTION.to_string(),
            data: original_markers2.clone(),
        });
        tag.write_to_path(&path, Version::Id3v24).unwrap();

        let mut edited = full_metadata();
        edited.cues[1].position_ms = 325;
        write_audio_file(&path, &edited, 1_000).unwrap();

        let tag = Tag::read_from_path(&path).unwrap();
        let markers = tag
            .encapsulated_objects()
            .find(|object| object.description == MARKERS_DESCRIPTION)
            .unwrap();
        let parsed = parse_markers(&markers.data).unwrap();
        assert_eq!(parsed.loops[2], original_loop);
        assert_eq!(
            parse_marker_position(&parsed.cues[1][..5]).unwrap(),
            Some(325)
        );
        assert_eq!(
            tag.encapsulated_objects()
                .find(|object| object.description == MARKERS2_DESCRIPTION)
                .unwrap()
                .data,
            original_markers2
        );
    }

    #[test]
    fn mp4_markers_convert_to_and_from_the_legacy_marker_layout() {
        let markers = build_markers(&full_metadata(), 1_000, None).unwrap();
        let mp4 = build_markers_mp4(&markers).unwrap();
        assert_eq!(mp4.len(), 277);
        let parsed = parse_markers_mp4(&mp4).unwrap();
        assert_eq!(parsed.cues.len(), LEGACY_CUE_COUNT);
        assert_eq!(parsed.loops.len(), LEGACY_LOOP_COUNT);
        assert_eq!(
            decode_serato32(&parsed.track_color.unwrap()).unwrap(),
            0xFFFFFF
        );

        let serialized = serialize_existing_markers(&parsed);
        let reparsed = parse_markers(&serialized).unwrap();
        assert_eq!(reparsed.cues, parsed.cues);
        assert_eq!(reparsed.loops, parsed.loops);
        assert_eq!(reparsed.track_color, parsed.track_color);
    }

    #[test]
    fn mp4_markers_reject_truncated_or_oversized_payloads() {
        assert!(parse_markers_mp4(&[2, 5, 0, 0, 0, 65, 0, 0, 0, 0]).is_err());
        assert!(parse_markers_mp4(&[2, 5, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn mp4_empty_markers_match_the_serato_footer_layout() {
        let parsed = parse_markers_mp4(&[2, 5, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0]).unwrap();
        assert!(parsed.cues.is_empty());
        assert!(parsed.loops.is_empty());
        assert_eq!(
            decode_serato32(&parsed.track_color.unwrap()).unwrap(),
            0xFFFFFF
        );
    }

    #[test]
    fn mp4_markers_accept_serato_nonzero_footer() {
        let mut legacy =
            build_markers_mp4(&build_markers(&full_metadata(), 1_000, None).unwrap()).unwrap();
        *legacy.last_mut().unwrap() = 0x14;
        let parsed = parse_markers_mp4(&legacy).unwrap();
        assert_eq!(parsed.mp4_footer, Some(0x14));
        assert_eq!(parsed.cues.len(), LEGACY_CUE_COUNT);
    }

    #[test]
    fn mp4_markers_parse_a_real_serato_payload() {
        let encoded = concat!(
            "AgUAAAAO//////////8A/////wAAAAAAAP//////////AP////8AAAAAAAD/",
            "/////////wD/////AAAAAAAA//////////8A/////wAAAAAAAP//////////",
            "AP////8AAAAAAAD//////////wD/////AAAAAAMA//////////8A/////wAA",
            "AAADAP//////////AP////8AAAAAAwD//////////wD/////AAAAAAMA////",
            "//////8A/////wAAAAADAP//////////AP////8AAAAAAwD//////////wD/",
            "////AAAAAAMA//////////8A/////wAAAAADAP//////////AP////8AAAAA",
            "AwAA////AA=="
        );
        let decoded = decode_serato_base64(encoded.as_bytes()).unwrap();
        assert_eq!(decoded.len(), 277);
        let parsed = parse_markers_mp4(&decoded).unwrap();
        assert_eq!(parsed.cues.len(), LEGACY_CUE_COUNT);
        assert_eq!(parsed.loops.len(), LEGACY_LOOP_COUNT);
    }

    #[test]
    fn vorbis_and_mp4_marker_envelopes_follow_their_container_encodings() {
        let markers2 = build_markers2(&full_metadata(), 1_000, None).unwrap();
        let content = markers2_content_from_id3(&markers2).unwrap();

        let flac = encode_marker2_comment(&markers2, true);
        let decoded_flac = decode_marker2_comment(&flac, true).unwrap();
        assert_eq!(decoded_flac, markers2);
        assert_eq!(
            parse_container_markers2(&decoded_flac)
                .unwrap()
                .entries
                .len(),
            4
        );
        assert!(flac.contains('\n'));

        let ogg = encode_marker2_comment(&content, false);
        assert_eq!(decode_marker2_comment(&ogg, false).unwrap(), content);

        let envelope = decode_serato_base64(
            encode_markers2_envelope(&markers2, MARKERS2_DESCRIPTION).as_bytes(),
        )
        .unwrap();
        assert!(envelope.starts_with(b"application/octet-stream\0\0Serato Markers2\0\x01\x01AQ"));
    }

    #[test]
    fn reads_serato_mp4_markers2_with_named_cues_and_saved_loops() {
        // Decoded markersv2 payload from a Serato-tagged MP4 (serato-tags project).
        let encoded = concat!(
            "AQFDT0xPUgAAAAAEAP///0NVRQAAAAASAAAAAAD+AMwAAAAAU3RhcnQAQ1VFAAAAABgAAQAA\n",
            "UoQAzIgAAABBZnRlciBJbnRybwBDVUUAAAAAEgADAAHqIADMzAAAAEJyZWFrAENVRQAAAAAN\n",
            "AAQAAmyPAADMAAAAAENVRQAAAAANAAUAAOVBAMwAzAAAAENVRQAAAAAQAAcAA0CEAIgAzAAA\n",
            "RW5kAExPT1AAAAAAFQAAAAAA/gAACSX/////ACeq4QAAAExPT1AAAAAAJAACAAGITAABqOj/\n",
            "////ACeq4QAARWxlY3RyaWMgR3VpdGFyAExPT1AAAAAAIAADAAEmeQABNsf/////ACeq4QAB\n",
            "TG9ja2VkIGxvb3AAQlBNTE9DSwAAAAABAA"
        );
        let mut payload = [1, 1].to_vec();
        payload.extend_from_slice(encoded.as_bytes());
        payload.resize(514, 0);
        let parsed = parse_container_markers2(&payload).unwrap();
        let metadata = merge_marker_sources(None, Some(&parsed), None).unwrap();
        assert!(metadata.cues.iter().any(|cue| cue.label == "After Intro"));
        assert!(metadata
            .loops
            .iter()
            .any(|saved| saved.label == "Locked loop"));
        let enveloped = encode_markers2_envelope(&payload, MARKERS2_DESCRIPTION);
        let roundtrip = decode_markers2_envelope(&enveloped, MARKERS2_DESCRIPTION).unwrap();
        assert_eq!(roundtrip, payload);
    }

    #[test]
    fn reads_serato_authored_m4a_without_modifying_it_when_fixture_is_supplied() {
        let Ok(path) = std::env::var("OLOOPER_SERATO_M4A_FIXTURE") else {
            return;
        };
        let before = fs::read(&path).unwrap();
        let read = read_audio_file(Path::new(&path)).unwrap();
        assert!(read.markers_present);
        assert!(read.metadata.cues.iter().any(|cue| cue.slot == 2));
        let root = tempfile::tempdir().unwrap();
        let copy = root.path().join("serato-cue-edit.m4a");
        fs::copy(&path, &copy).unwrap();
        let marker2_ident = Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS2_NAME);
        let existing_marker2 = Mp4Tag::read_from_path(&copy)
            .unwrap()
            .userdata
            .data_of(&marker2_ident)
            .find_map(|data| data.string().map(str::to_owned));
        let mut edited = read.metadata.clone();
        edited
            .cues
            .iter_mut()
            .find(|cue| cue.slot == 2)
            .unwrap()
            .position_ms = 500;
        write_audio_file(&copy, &edited, 60_000).unwrap();
        assert_eq!(
            read_audio_file(&copy)
                .unwrap()
                .metadata
                .cues
                .iter()
                .find(|cue| cue.slot == 2)
                .unwrap()
                .position_ms,
            500
        );
        let updated_marker2 = Mp4Tag::read_from_path(&copy)
            .unwrap()
            .userdata
            .data_of(&marker2_ident)
            .find_map(|data| data.string().map(str::to_owned));
        assert_eq!(updated_marker2, existing_marker2);
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn supported_containers_roundtrip_when_afconvert_is_available() {
        if !cfg!(target_os = "macos") || Command::new("afconvert").arg("-hf").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-codecs-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.wav");
        fs::write(&source, wav_with_ramp(8_000)).unwrap();

        for (extension, format, codec) in [
            ("aif", "AIFF", "BEI16"),
            ("flac", "flac", "flac"),
            ("m4a", "m4af", "alac"),
        ] {
            let path = root.join(format!("track.{extension}"));
            let output = Command::new("afconvert")
                .arg("-f")
                .arg(format)
                .arg("-d")
                .arg(codec)
                .arg(&source)
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "afconvert failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let mut metadata = full_metadata();
            if extension == "m4a" {
                metadata.bpm = Some(124.0);
            }
            write_audio_file(&path, &metadata, 1_000).unwrap();
            assert_eq!(read_audio_file(&path).unwrap().metadata, metadata);
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mp3_ogg_and_aac_files_roundtrip_when_real_fixtures_are_supplied() {
        let Ok(folder) = std::env::var("OLOOPER_SERATO_FORMAT_FIXTURES") else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        for extension in ["mp3", "ogg", "m4a"] {
            let input = Path::new(&folder).join(format!("serato-fixture.{extension}"));
            let output = root.path().join(format!("track.{extension}"));
            fs::copy(&input, &output).unwrap();
            let metadata = SeratoMetadata {
                cues: vec![SeratoCue {
                    slot: 2,
                    label: "B".into(),
                    position_ms: 100,
                }],
                ..SeratoMetadata::default()
            };
            write_audio_file(&output, &metadata, 1_000).unwrap();
            let stored = read_audio_file(&output).unwrap();
            assert!(stored.markers_present, "{extension} lost its marker tag");
            assert!(
                stored
                    .metadata
                    .cues
                    .iter()
                    .any(|cue| cue.slot == 2 && cue.position_ms == 100),
                "{extension} lost CUE 2"
            );
            if extension == "m4a" {
                // Simulate Serato changing the two MP4 marker atoms directly.
                let edited = SeratoMetadata {
                    cues: vec![SeratoCue {
                        slot: 2,
                        label: "Edited in Serato".into(),
                        position_ms: 321,
                    }],
                    ..SeratoMetadata::default()
                };
                let legacy =
                    build_markers_mp4(&build_markers(&edited, 1_000, None).unwrap()).unwrap();
                let modern = build_markers2(&edited, 1_000, None).unwrap();
                let mut tag = Mp4Tag::read_from_path(&output).unwrap();
                tag.userdata.set_data(
                    Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS_NAME),
                    Mp4Data::Utf8(encode_markers2_envelope(&legacy, MARKERS_DESCRIPTION)),
                );
                tag.userdata.set_data(
                    Mp4DataIdent::freeform(SERATO_MP4_MEAN, SERATO_MP4_MARKERS2_NAME),
                    Mp4Data::Utf8(encode_markers2_envelope(&modern, MARKERS2_DESCRIPTION)),
                );
                tag.write_to_path(&output).unwrap();
                let reloaded = read_audio_file(&output).unwrap();
                assert!(reloaded.metadata.cues.iter().any(|cue| cue.slot == 2
                    && cue.position_ms == 321
                    && cue.label == "Edited in Serato"));
            }
        }
    }

    #[test]
    fn serato32_positions_roundtrip_across_full_supported_range() {
        for position in [0, 1, 255, 65_535, 1_000_000, 0x00ff_ffff] {
            assert_eq!(decode_serato32(&serato32(position)).unwrap(), position);
        }
    }

    #[test]
    fn marker2_replacement_preserves_unknown_serato_entries() {
        let previous = build_markers2(&full_metadata(), 1_000, None).unwrap();
        let mut old = parse_markers2(&previous).unwrap();
        let unknown = markers2_entry("VENDOR", vec![1, 2, 3]);
        old.entries.push(Markers2Entry {
            name: "VENDOR".to_string(),
            index: None,
            raw: unknown.clone(),
        });
        let previous = encode_markers2(
            old.outer_version.unwrap(),
            old.content_version.unwrap(),
            &old.entries
                .into_iter()
                .map(|entry| entry.raw)
                .collect::<Vec<_>>(),
        );

        let mut edited = full_metadata();
        edited.cues.retain(|cue| cue.slot != 2);
        edited.cues.push(SeratoCue {
            slot: 2,
            label: "Updated B".to_string(),
            position_ms: 321,
        });
        let updated = build_markers2(&edited, 1_000, Some(&previous)).unwrap();
        let parsed = parse_markers2(&updated).unwrap();
        assert!(parsed.entries.iter().any(|entry| entry.raw == unknown));
        let merged = merge_marker_sources(None, Some(&parsed), None).unwrap();
        assert_eq!(merged.cues[1].position_ms, 321);
        assert_eq!(merged.cues[1].label, "Updated B");
    }

    #[test]
    fn duplicate_wave_id3_chunks_are_merged_and_rewritten_as_serato_lowercase_chunk() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-duplicate-id3-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("duplicate.wav");
        fs::write(&path, wav_with_ramp(8_000)).unwrap();

        // Start with Serato's lowercase chunk, then add the uppercase chunk
        // produced by the previous WAV tag writer, containing the actual cues.
        let mut original = Tag::new();
        original.set_text("TIT2", "Original");
        write_audio_tag(&path, &original).unwrap();
        let updated = SeratoMetadata {
            cues: vec![SeratoCue {
                slot: 2,
                label: "B".to_string(),
                position_ms: 250,
            }],
            ..SeratoMetadata::default()
        };
        let markers = build_markers(&updated, 1_000, None).unwrap();
        let markers2 = build_markers2(&updated, 1_000, None).unwrap();
        let mut uppercase_id3 = Vec::new();
        let mut tag = Tag::new();
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: MARKERS_DESCRIPTION.to_string(),
            data: markers,
        });
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: MARKERS2_DESCRIPTION.to_string(),
            data: markers2,
        });
        tag.write_to(&mut uppercase_id3, Version::Id3v24).unwrap();
        append_wav_chunk(&path, *b"ID3 ", &uppercase_id3);

        let before = read_audio_file(&path).unwrap();
        assert!(before.needs_wave_id3_normalization);
        assert_eq!(before.metadata.cues[1].position_ms, 250);
        write_audio_file(&path, &before.metadata, 1_000).unwrap();

        let bytes = fs::read(&path).unwrap();
        assert_eq!(wav_id3_chunk_ids(&bytes), vec![*b"id3 "]);
        let after = read_audio_file(&path).unwrap();
        assert!(!after.needs_wave_id3_normalization);
        assert_eq!(after.metadata.cues[1].position_ms, 250);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleared_lowercase_wave_markers_are_not_resurrected_from_uppercase_chunk() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-cleared-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("cleared.wav");
        fs::write(&path, wav_with_ramp(8_000)).unwrap();
        write_audio_file(&path, &SeratoMetadata::default(), 1_000).unwrap();

        let mut stale = Tag::new();
        let old = SeratoMetadata {
            cues: vec![SeratoCue {
                slot: 2,
                label: "Old B".into(),
                position_ms: 250,
            }],
            ..SeratoMetadata::default()
        };
        stale.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".into(),
            filename: String::new(),
            description: MARKERS_DESCRIPTION.into(),
            data: build_markers(&old, 1_000, None).unwrap(),
        });
        stale.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".into(),
            filename: String::new(),
            description: MARKERS2_DESCRIPTION.into(),
            data: build_markers2(&old, 1_000, None).unwrap(),
        });
        let mut uppercase = Vec::new();
        stale.write_to(&mut uppercase, Version::Id3v24).unwrap();
        append_wav_chunk(&path, *b"ID3 ", &uppercase);

        let read = read_audio_file(&path).unwrap();
        assert!(read.needs_wave_id3_normalization);
        assert!(!read.metadata.cues.iter().any(|cue| cue.slot == 2));
        write_audio_file(&path, &read.metadata, 1_000).unwrap();
        assert!(!read_audio_file(&path)
            .unwrap()
            .metadata
            .cues
            .iter()
            .any(|cue| cue.slot == 2));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn audio_file_roundtrip_keeps_four_cues_bpm_audio_and_existing_markers2() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-sync-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("loop.wav");
        let audio = wav_with_ramp(8_000);
        let expected_audio = wav_data(&audio).to_vec();
        fs::write(&path, audio).unwrap();
        let metadata = full_metadata();
        let markers2_original = build_markers2(&metadata, 1_000, None).unwrap();

        let mut tag = Tag::new();
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: "Other Serato metadata".to_string(),
            data: vec![1, 2, 3],
        });
        tag.add_frame(EncapsulatedObject {
            mime_type: "application/octet-stream".to_string(),
            filename: String::new(),
            description: MARKERS2_DESCRIPTION.to_string(),
            data: markers2_original.clone(),
        });
        tag.write_to_path(&path, Version::Id3v24).unwrap();
        assert!(read_audio_file(&path).unwrap().needs_wave_id3_normalization);

        write_audio_file(&path, &metadata, 1_000).unwrap();

        let tag = Tag::read_from_path(&path).unwrap();
        assert_eq!(tag.get("TBPM").unwrap().content().text(), Some("123.5"));
        assert!(tag
            .encapsulated_objects()
            .any(|object| object.description == "Other Serato metadata"));
        let markers = tag
            .encapsulated_objects()
            .find(|object| object.description == MARKERS_DESCRIPTION)
            .unwrap();
        let parsed = parse_markers(&markers.data).unwrap();
        assert_eq!(parsed.cues.len(), LEGACY_CUE_COUNT);
        assert_eq!(parsed.loops.len(), LEGACY_LOOP_COUNT);
        assert_eq!(
            tag.encapsulated_objects()
                .find(|object| object.description == MARKERS2_DESCRIPTION)
                .unwrap()
                .data,
            markers2_original
        );
        let read = read_audio_file(&path).unwrap();
        assert!(read.markers_present);
        assert_eq!(read.metadata, metadata);
        assert_eq!(wav_data(&fs::read(&path).unwrap()), expected_audio);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extracted_mp3_gets_artist_album_and_front_cover_id3_frames() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("extract.mp3");
        let mut mp3 = vec![0; 128];
        mp3[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        fs::write(&path, mp3).unwrap();
        let mut cover = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cover, 85)
            .encode(&[0, 255, 0], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();

        write_extracted_audio_tags(
            &path,
            Some("Nina Simone"),
            "Friendly Melodies",
            Some(&cover),
        )
        .unwrap();

        let tag = read_audio_tag(&path).unwrap().tag;
        assert_eq!(tag.artist(), Some("Nina Simone"));
        assert_eq!(tag.album(), Some("Friendly Melodies"));
        let picture = tag.pictures().next().unwrap();
        assert_eq!(picture.mime_type, "image/jpeg");
        assert_eq!(picture.picture_type, PictureType::CoverFront);
        assert_eq!(picture.data, cover);
    }

    #[test]
    fn serato_sync_adds_markers_to_a_tagless_wav() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-tagless-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("loop.wav");
        fs::write(&path, wav_with_ramp(8_000)).unwrap();

        let metadata = SeratoMetadata {
            cues: vec![SeratoCue {
                slot: 2,
                label: "B".to_string(),
                position_ms: 250,
            }],
            ..SeratoMetadata::default()
        };
        write_audio_file(&path, &metadata, 1_000).unwrap();

        let tag = Tag::read_from_path(&path).unwrap();
        assert!(tag
            .encapsulated_objects()
            .any(|object| object.description == MARKERS_DESCRIPTION));
        assert!(!tag
            .encapsulated_objects()
            .any(|object| object.description == MARKERS2_DESCRIPTION));
        let read = read_audio_file(&path).unwrap().metadata;
        assert_eq!(
            read.cues
                .iter()
                .find(|cue| cue.slot == 2)
                .unwrap()
                .position_ms,
            250
        );
        assert_eq!(
            read.cues
                .iter()
                .find(|cue| cue.slot == 1)
                .unwrap()
                .position_ms,
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsupported_serato_sync_does_not_modify_audio() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-unsupported-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("loop.m4a");
        fs::write(&path, b"unchanged").unwrap();

        assert!(write_audio_file(&path, &SeratoMetadata::default(), 1_000).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unchanged");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn serato_sync_preserves_existing_bpm_when_library_has_no_bpm() {
        let root = std::env::temp_dir().join(format!(
            "olooper-serato-preserve-bpm-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("loop.wav");
        fs::write(&path, wav_with_ramp(8_000)).unwrap();
        let mut tag = Tag::new();
        tag.set_text("TBPM", "97");
        tag.write_to_path(&path, Version::Id3v24).unwrap();

        write_audio_file(&path, &SeratoMetadata::default(), 1_000).unwrap();

        let tag = Tag::read_from_path(&path).unwrap();
        assert_eq!(tag.get("TBPM").unwrap().content().text(), Some("97"));
        fs::remove_dir_all(root).unwrap();
    }
}
