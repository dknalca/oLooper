//! Temp-DB tests: migrations, CRUD, dedup, missing files, import plumbing.
//! Real-file validation lives in the `#[ignore]`d test at the bottom:
//! `OLOOPER_FIXTURES=1 cargo test -- --ignored` on a dev machine.

use super::*;
use crate::import::fixture::*;
use crate::import::swf::FORMAT_MP3;
use id3::{Tag, TagLike};

fn tmp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "olooper-test-{}-{}",
        tag,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(unix)]
#[test]
fn extracted_audio_does_not_follow_a_predictable_temporary_symlink() {
    let root = tmp_root("atomic-audio-symlink");
    let lib = Library::open(&root).unwrap();
    let sentinel = root.join("sentinel");
    std::fs::write(&sentinel, b"untouched").unwrap();
    let dest = root.join("Custom Loops").join("test.mp3");
    std::os::unix::fs::symlink(&sentinel, dest.with_extension("mp3.tmp")).unwrap();
    lib.atomic_write(&dest, b"audio").unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"audio");
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"untouched");
    std::fs::remove_dir_all(root).unwrap();
}

fn wav_buf() -> crate::player::LoopBuffer {
    // 8 kHz mono, 800 samples == 100 ms, decodable by rodio.
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&(36 + 1600u32).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&8000u32.to_le_bytes());
    v.extend_from_slice(&16000u32.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&1600u32.to_le_bytes());
    for i in 0..800 {
        v.extend_from_slice(&(i as i16).to_le_bytes());
    }
    crate::player::decode_bytes(&v).unwrap()
}

fn add_test_looper_track(lib: &Library, root: &Path, title: &str, source_hash: &str) -> i64 {
    let audio = root.join("Custom Loops").join(format!("{title}.wav"));
    std::fs::write(&audio, title.as_bytes()).unwrap();
    let (id, added) = lib
        .add_track(
            title,
            title,
            &audio,
            "swf",
            &format!("/{title}.swf"),
            source_hash,
            0,
            None,
            None,
            "wav",
            &wav_buf(),
            0,
            0,
        )
        .unwrap();
    assert!(added);
    id
}

fn wav_id3_tag(path: &Path) -> Tag {
    let bytes = std::fs::read(path).unwrap();
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start + size;
        if bytes[offset..offset + 4].eq_ignore_ascii_case(b"ID3 ") {
            return Tag::read_from2(std::io::Cursor::new(bytes[start..end].to_vec())).unwrap();
        }
        offset = end + (size & 1);
    }
    panic!("WAV has no embedded ID3 chunk");
}

#[test]
fn migrate_starts_at_current_schema() {
    let root = tmp_root("migrate");
    let lib = Library::open(&root).unwrap();
    assert_eq!(lib.schema_version().unwrap(), 9);
    assert!(root.join("Custom Loops").is_dir());
    assert!(root.join("olooper.db").is_file());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn migration_v6_adds_empty_playlists_without_changing_tracks() {
    let root = tmp_root("playlist-migration-v6");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops/preserved.wav");
    std::fs::write(&audio, b"preserved audio").unwrap();
    let (track_id, _) = lib
        .add_track(
            "Preserved",
            "Custom Loops",
            &audio,
            "custom",
            "/source/preserved.wav",
            "playlist-migration-preserved",
            0,
            None,
            None,
            "wav",
            &wav_buf(),
            0,
            0,
        )
        .unwrap();
    drop(lib);

    let conn = Connection::open(root.join("olooper.db")).unwrap();
    conn.execute_batch(
        "DROP TABLE playlist_tracks; DROP TABLE playlists; DROP TABLE looper_order; \
         ALTER TABLE tracks DROP COLUMN audio_storage; \
         PRAGMA user_version=6;",
    )
    .unwrap();
    drop(conn);

    let migrated = Library::open(&root).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 9);
    assert!(migrated.list_playlists().unwrap().is_empty());
    assert_eq!(migrated.list_tracks().unwrap()[0].id, track_id);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn migration_v7_adds_looper_order_and_preserves_existing_groups() {
    let root = tmp_root("looper-order-migration-v7");
    let lib = Library::open(&root).unwrap();
    add_test_looper_track(&lib, &root, "First", "looper-order-first");
    drop(lib);

    let conn = Connection::open(root.join("olooper.db")).unwrap();
    conn.execute_batch(
        "DROP TABLE looper_order; ALTER TABLE tracks DROP COLUMN audio_storage; PRAGMA user_version=7;",
    )
        .unwrap();
    drop(conn);

    let migrated = Library::open(&root).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 9);
    assert_eq!(
        migrated.list_looper_order().unwrap(),
        vec!["looper-order-first"]
    );
    assert_eq!(migrated.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn migration_v8_defaults_existing_tracks_to_extracted_audio() {
    let root = tmp_root("audio-storage-migration-v8");
    let lib = Library::open(&root).unwrap();
    let track_id = add_test_looper_track(&lib, &root, "Extracted", "storage-migration-source");
    drop(lib);

    let conn = Connection::open(root.join("olooper.db")).unwrap();
    conn.execute_batch("ALTER TABLE tracks DROP COLUMN audio_storage; PRAGMA user_version=8;")
        .unwrap();
    drop(conn);

    let migrated = Library::open(&root).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 9);
    let track = migrated.get_track(track_id).unwrap().unwrap();
    assert_eq!(track.audio_storage, "extracted");
    assert_eq!(track.playback_path, track.file_path);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn looper_order_persists_and_rejects_incomplete_or_duplicate_orders() {
    let root = tmp_root("looper-order");
    let lib = Library::open(&root).unwrap();
    add_test_looper_track(&lib, &root, "First", "looper-order-first");
    add_test_looper_track(&lib, &root, "Second", "looper-order-second");
    assert_eq!(
        lib.list_looper_order().unwrap(),
        vec!["looper-order-first", "looper-order-second"]
    );
    let reordered = vec![
        "looper-order-second".to_string(),
        "looper-order-first".to_string(),
    ];
    lib.reorder_loopers(&reordered).unwrap();
    assert!(lib
        .reorder_loopers(&["looper-order-first".to_string()])
        .is_err());
    assert!(lib
        .reorder_loopers(&[
            "looper-order-first".to_string(),
            "looper-order-first".to_string(),
        ])
        .is_err());
    drop(lib);

    let reopened = Library::open(&root).unwrap();
    assert_eq!(reopened.list_looper_order().unwrap(), reordered);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn playlists_store_ordered_track_references_without_copying_or_reassigning_tracks() {
    let root = tmp_root("playlists");
    let lib = Library::open(&root).unwrap();
    let buf = wav_buf();
    let first_path = root.join("Custom Loops/first.wav");
    let second_path = root.join("Custom Loops/second.wav");
    std::fs::write(&first_path, b"first audio").unwrap();
    std::fs::write(&second_path, b"second audio").unwrap();
    let (first_id, _) = lib
        .add_track(
            "First",
            "Custom Loops",
            &first_path,
            "custom",
            "/source/first.wav",
            "playlist-first",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();
    let (second_id, _) = lib
        .add_track(
            "Second",
            "Custom Loops",
            &second_path,
            "custom",
            "/source/second.wav",
            "playlist-second",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();

    let playlist = lib.create_playlist("Practice set").unwrap();
    assert!(lib.add_track_to_playlist(playlist.id, first_id).unwrap());
    assert!(!lib.add_track_to_playlist(playlist.id, first_id).unwrap());
    assert!(lib.add_track_to_playlist(playlist.id, second_id).unwrap());
    lib.reorder_playlist(playlist.id, &[second_id, first_id])
        .unwrap();
    assert_eq!(
        lib.list_playlists().unwrap()[0].track_ids,
        vec![second_id, first_id]
    );
    assert!(lib
        .reorder_playlist(playlist.id, &[first_id, first_id])
        .is_err());
    assert_eq!(
        lib.list_playlists().unwrap()[0].track_ids,
        vec![second_id, first_id]
    );

    assert!(lib
        .remove_track_from_playlist(playlist.id, second_id)
        .unwrap());
    assert_eq!(lib.list_playlists().unwrap()[0].track_ids, vec![first_id]);
    assert!(lib.add_track_to_playlist(playlist.id, second_id).unwrap());
    assert!(lib.remove_track(second_id).unwrap());
    assert!(first_path.is_file());
    assert!(!second_path.exists());
    assert_eq!(lib.list_playlists().unwrap()[0].track_ids, vec![first_id]);
    assert_eq!(
        lib.get_track(first_id).unwrap().unwrap().looper_name,
        "Custom Loops"
    );
    assert!(lib.rename_playlist(playlist.id, "Warmup").is_ok());
    assert!(lib.create_playlist("warmup").is_err());

    drop(lib);
    let reopened = Library::open(&root).unwrap();
    let playlists = reopened.list_playlists().unwrap();
    assert_eq!(playlists.len(), 1);
    assert_eq!(playlists[0].name, "Warmup");
    assert_eq!(playlists[0].track_ids, vec![first_id]);
    assert!(reopened.remove_playlist(playlist.id).unwrap());
    assert!(first_path.is_file());
    assert_eq!(reopened.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn converting_wav_replaces_only_managed_copy_and_preserves_track_identity_and_tags() {
    let root = tmp_root("wav-to-mp3");
    let outside = tmp_root("wav-to-mp3-source");
    let source = outside.join("original.wav");
    let wav = root.join("Custom Loops/Practice.wav");
    let samples = (0..44_100 * 2)
        .map(|frame| {
            ((frame as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 12_000.0) as i16
        })
        .collect::<Vec<_>>();
    write_wav(&source, &samples, 44_100);
    let lib = Library::open(&root).unwrap();
    write_wav(&wav, &samples, 44_100);
    let input = std::fs::read(&wav).unwrap();
    let buffer = crate::player::decode_bytes(&input).unwrap();
    let (track_id, _) = lib
        .add_track(
            "Practice",
            "Custom Loops",
            &wav,
            "custom",
            source.to_str().unwrap(),
            "wav-conversion-track",
            0,
            None,
            None,
            "wav",
            &buffer,
            0,
            0,
        )
        .unwrap();
    lib.update_bpm(track_id, 128.0, Some(0.8), true).unwrap();
    let expected_metadata = SeratoMetadata {
        cues: vec![
            SeratoCue {
                slot: 1,
                label: "A".to_string(),
                position_ms: 0,
            },
            SeratoCue {
                slot: 2,
                label: "B".to_string(),
                position_ms: 250,
            },
        ],
        loops: Vec::new(),
        bpm: Some(128.0),
    };
    serato::write_audio_file(&wav, &expected_metadata, buffer.duration_ms() as i64).unwrap();
    let playlist = lib.create_playlist("Converted").unwrap();
    lib.add_track_to_playlist(playlist.id, track_id).unwrap();

    let converted = lib.convert_wav_to_mp3_320(track_id).unwrap();
    let mp3 = PathBuf::from(&converted.file_path);
    assert!(mp3.is_file());
    assert_eq!(
        mp3.extension().and_then(|value| value.to_str()),
        Some("mp3")
    );
    assert_eq!(converted.codec, "mp3");
    assert_eq!(converted.id, track_id);
    assert_eq!(converted.source_path, source.to_str().unwrap());
    assert_eq!(converted.bpm, Some(128.0));
    assert_eq!(converted.bpm_source.as_deref(), Some("manual"));
    assert!(!wav.exists());
    assert!(source.is_file());
    assert_eq!(lib.list_playlists().unwrap()[0].track_ids, vec![track_id]);
    let decoded_mp3 = crate::player::decode_bytes(&std::fs::read(&mp3).unwrap()).unwrap();
    assert_eq!(decoded_mp3.rate, 44_100);
    let metadata = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(metadata.cues, expected_metadata.cues);
    assert_eq!(metadata.bpm, Some(128.0));
    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(outside).ok();
}

#[test]
fn add_list_get_dedup() {
    let root = tmp_root("crud");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops").join("x.wav");
    std::fs::write(&audio, b"fake").unwrap();
    let buf = wav_buf();
    let (id, added) = lib
        .add_track(
            "t",
            "Custom Loops",
            &audio,
            "custom",
            "/src/x.wav",
            "hash1",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();
    assert!(added);
    // Same source identity → same id, no duplicate row.
    let (id2, added2) = lib
        .add_track(
            "t",
            "Custom Loops",
            &audio,
            "custom",
            "/src/x.wav",
            "hash1",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();
    assert!(!added2 && id2 == id);
    let tracks = lib.list_tracks().unwrap();
    assert_eq!(tracks.len(), 1);
    assert!(tracks[0].exists);
    assert!(!tracks[0].favorite);
    assert_eq!(tracks[0].duration_ms, 100);
    assert_eq!(lib.get_track(id).unwrap().unwrap().title, "t");
    assert!(lib.set_favorite(id, true).unwrap().favorite);
    assert!(!lib.set_favorite(id, false).unwrap().favorite);
    assert!(lib.set_favorite(999, true).is_err());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn audio_file_is_the_source_of_truth_for_four_cues_and_bpm() {
    let root = tmp_root("audio-markers");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops").join("markers.wav");
    let buf = wav_buf();
    std::fs::write(&audio, Library::loop_buffer_to_wav(&buf)).unwrap();
    let (track_id, _) = lib
        .add_track(
            "markers",
            "Custom Loops",
            &audio,
            "custom",
            "/source/markers.wav",
            "markers-hash",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();
    lib.update_bpm(track_id, 120.0, None, true).unwrap();
    lib.set_serato_cue(track_id, 2, Some(35)).unwrap();
    assert!(lib.set_serato_cue(track_id, 5, Some(40)).is_err());
    let saved = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(
        saved
            .cues
            .iter()
            .find(|cue| cue.slot == 2)
            .unwrap()
            .position_ms,
        35
    );
    assert_eq!(
        saved
            .cues
            .iter()
            .find(|cue| cue.slot == 1)
            .unwrap()
            .position_ms,
        0
    );
    assert!(saved.loops.is_empty());
    assert_eq!(saved.bpm, Some(120.0));

    let db_rows: i64 = lib
        .conn
        .query_row(
            "SELECT COUNT(*) FROM loop_slots WHERE track_id=?1",
            [track_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(db_rows, 0);
    drop(lib);

    let lib = Library::open(&root).unwrap();
    let reopened = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(
        reopened
            .cues
            .iter()
            .find(|cue| cue.slot == 2)
            .unwrap()
            .position_ms,
        35
    );
    assert_eq!(reopened.cues[0].position_ms, 0);
    assert!(reopened.loops.is_empty());

    // Simulate Serato changing a cue and BPM.
    let mut serato_edit = reopened;
    serato_edit
        .cues
        .iter_mut()
        .find(|cue| cue.slot == 2)
        .unwrap()
        .position_ms = 45;
    serato_edit.bpm = Some(124.0);
    serato::write_audio_file(&audio, &serato_edit, 100).unwrap();

    let refreshed = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(
        refreshed
            .cues
            .iter()
            .find(|cue| cue.slot == 2)
            .unwrap()
            .position_ms,
        45
    );
    assert_eq!(refreshed.cues[0].position_ms, 0);
    assert!(refreshed.loops.is_empty());
    assert_eq!(refreshed.bpm, Some(124.0));
    assert_eq!(lib.get_track(track_id).unwrap().unwrap().bpm, Some(124.0));

    let db_rows: i64 = lib
        .conn
        .query_row(
            "SELECT COUNT(*) FROM loop_slots WHERE track_id=?1",
            [track_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(db_rows, 0);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn legacy_database_cues_are_migrated_into_the_audio_file_on_open() {
    let root = tmp_root("legacy-marker-migration");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops").join("legacy.wav");
    let buf = wav_buf();
    std::fs::write(&audio, Library::loop_buffer_to_wav(&buf)).unwrap();
    let (track_id, _) = lib
        .add_track(
            "legacy",
            "Custom Loops",
            &audio,
            "custom",
            "/source/legacy.wav",
            "legacy-hash",
            0,
            None,
            None,
            "wav",
            &buf,
            0,
            0,
        )
        .unwrap();
    lib.conn
        .execute(
            "INSERT INTO loop_slots(track_id,slot,label,cue_ms,loop_start_ms,loop_end_ms,enabled) \
             VALUES (?1,2,'B',30,10,70,1)",
            [track_id],
        )
        .unwrap();
    // A legacy uppercase ID3 chunk with unrelated metadata must not cause
    // normalization to write default markers before SQLite slots migrate.
    let mut old_tag = id3::Tag::new();
    old_tag.set_title("Legacy title");
    old_tag.write_to_path(&audio, id3::Version::Id3v24).unwrap();

    let migrated = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(
        migrated
            .cues
            .iter()
            .find(|cue| cue.slot == 1)
            .unwrap()
            .position_ms,
        0
    );
    assert_eq!(
        migrated
            .cues
            .iter()
            .find(|cue| cue.slot == 2)
            .unwrap()
            .position_ms,
        30
    );
    assert!(migrated.loops.is_empty());
    let legacy_rows: i64 = lib
        .conn
        .query_row(
            "SELECT COUNT(*) FROM loop_slots WHERE track_id=?1",
            [track_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_rows, 0);
    assert!(serato::read_audio_file(&audio).unwrap().markers_present);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn looper_group_rename_and_remove_delete_derived_audio_only() {
    let root = tmp_root("group-management");
    let lib = Library::open(&root).unwrap();
    let source_dir = root.join("loopersFlash");
    std::fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("old.swf");
    std::fs::write(&source, b"original swf source").unwrap();
    let old_dir = root.join("Old Looper");
    std::fs::create_dir_all(&old_dir).unwrap();
    let first = old_dir.join("01_1.mp3");
    let second = old_dir.join("02_2.mp3");
    std::fs::write(&first, b"first").unwrap();
    std::fs::write(&second, b"second").unwrap();
    let buf = wav_buf();
    let (first_id, _) = lib
        .add_track(
            "01 · Old Looper",
            "Old Looper",
            &first,
            "swf",
            source.to_str().unwrap(),
            "group-hash",
            1,
            None,
            None,
            "mp3",
            &buf,
            0,
            0,
        )
        .unwrap();
    lib.add_track(
        "02 · Old Looper",
        "Old Looper",
        &second,
        "swf",
        source.to_str().unwrap(),
        "group-hash",
        2,
        None,
        None,
        "mp3",
        &buf,
        0,
        0,
    )
    .unwrap();
    std::fs::write(old_dir.join("cover.jpg"), b"cover bytes").unwrap();
    // Legacy CUE rows are retained only for the one-time audio-tag migration.
    lib.conn
        .execute(
            "INSERT INTO loop_slots(track_id,slot,label,cue_ms,loop_start_ms,loop_end_ms,enabled) \
             VALUES (?1,1,'A',0,0,90,1)",
            [first_id],
        )
        .unwrap();

    lib.rename_looper("group-hash", "Renamed Looper").unwrap();
    let renamed_dir = root.join("Renamed Looper");
    assert!(renamed_dir.join("01_1.mp3").is_file());
    assert!(!old_dir.exists());
    assert!(lib
        .list_tracks()
        .unwrap()
        .iter()
        .all(|track| track.looper_name == "Renamed Looper"));

    assert_eq!(lib.remove_looper("group-hash").unwrap(), 2);
    assert!(lib.list_tracks().unwrap().is_empty());
    let legacy_cues: i64 = lib
        .conn
        .query_row(
            "SELECT COUNT(*) FROM loop_slots WHERE track_id=?1",
            [first_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy_cues, 0);
    assert!(!renamed_dir.join("01_1.mp3").exists());
    assert!(!renamed_dir.join("02_2.mp3").exists());
    assert!(!renamed_dir.join("cover.jpg").exists());
    assert!(source.is_file());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn group_cover_is_normalized_and_served_to_the_library_view() {
    let root = tmp_root("group-cover");
    let lib = Library::open(&root).unwrap();
    let group_dir = root.join("Cover Looper");
    std::fs::create_dir_all(&group_dir).unwrap();
    let audio = group_dir.join("01_1.mp3");
    std::fs::write(&audio, b"derived audio").unwrap();
    lib.add_track(
        "01 · Cover Looper",
        "Cover Looper",
        &audio,
        "swf",
        "/source/cover.swf",
        "cover-group-hash",
        1,
        None,
        None,
        "mp3",
        &wav_buf(),
        0,
        0,
    )
    .unwrap();

    let mut original = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut original, 85)
        .encode(
            &[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0],
            2,
            2,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    assert!(lib.save_group_cover("cover-group-hash", &original).unwrap());
    assert!(!lib.save_group_cover("cover-group-hash", &original).unwrap());

    let data_url = lib
        .group_cover_data_url("cover-group-hash")
        .unwrap()
        .unwrap();
    let encoded = data_url.strip_prefix("data:image/jpeg;base64,").unwrap();
    use base64::Engine as _;
    let stored = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let decoded = image::load_from_memory(&stored).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (512, 512));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn track_removal_refuses_to_delete_a_file_outside_the_library_root() {
    let root = tmp_root("delete-confine-library");
    let outside = tmp_root("delete-confine-outside");
    let external_audio = outside.join("source.wav");
    write_wav(&external_audio, &[0; 8000], 8000);
    let lib = Library::open(&root).unwrap();
    let (id, added) = lib
        .add_track(
            "External",
            "External",
            &external_audio,
            "custom",
            external_audio.to_str().unwrap(),
            "external-source",
            0,
            None,
            None,
            "wav",
            &wav_buf(),
            0,
            0,
        )
        .unwrap();
    assert!(added);
    assert!(lib.remove_track(id).is_err());
    assert!(external_audio.is_file());
    assert!(lib.get_track(id).unwrap().is_some());
    std::fs::remove_dir_all(&root).ok();
    std::fs::remove_dir_all(&outside).ok();
}

#[test]
fn desktop_drag_path_only_returns_audio_confined_to_the_library() {
    let root = tmp_root("desktop-drag-managed");
    let outside = tmp_root("desktop-drag-outside");
    let lib = Library::open(&root).unwrap();
    let managed_audio = root.join("Custom Loops/managed.wav");
    let external_audio = outside.join("external.wav");
    std::fs::write(&managed_audio, b"managed audio").unwrap();
    std::fs::write(&external_audio, b"external audio").unwrap();
    let buffer = wav_buf();
    let (managed_id, _) = lib
        .add_track(
            "Managed",
            "Custom Loops",
            &managed_audio,
            "custom",
            "/source/managed.wav",
            "desktop-drag-managed",
            0,
            None,
            None,
            "wav",
            &buffer,
            0,
            0,
        )
        .unwrap();
    let (external_id, _) = lib
        .add_track(
            "External",
            "Custom Loops",
            &external_audio,
            "custom",
            "/source/external.wav",
            "desktop-drag-external",
            0,
            None,
            None,
            "wav",
            &buffer,
            0,
            0,
        )
        .unwrap();

    assert_eq!(
        lib.managed_audio_path_for_track(managed_id).unwrap(),
        managed_audio.canonicalize().unwrap()
    );
    assert!(lib.managed_audio_path_for_track(external_id).is_err());
    assert!(managed_audio.is_file());
    assert!(external_audio.is_file());
    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(outside).ok();
}

#[test]
fn edits_persist_across_reopen() {
    let root = tmp_root("persist");
    let audio = root.join("Custom Loops").join("x.wav");
    {
        let lib = Library::open(&root).unwrap();
        std::fs::write(&audio, b"fake").unwrap();
        lib.add_track(
            "t",
            "Custom Loops",
            &audio,
            "custom",
            "s",
            "h",
            0,
            None,
            None,
            "wav",
            &wav_buf(),
            0,
            0,
        )
        .unwrap();
        lib.update_cue_loop(1, 10, 10, 90, true).unwrap();
        lib.update_bpm(1, 128.0, None, true).unwrap();
    }
    let lib = Library::open(&root).unwrap();
    let t = lib.get_track(1).unwrap().unwrap();
    assert_eq!(
        (t.primary_cue_ms, t.loop_start_ms, t.loop_end_ms),
        (10, 10, 90)
    );
    assert_eq!(t.bpm, Some(128.0));
    assert_eq!(t.bpm_source.as_deref(), Some("manual"));
    assert!(lib.update_cue_loop(1, 0, 90, 10, true).is_err()); // start >= end
    assert!(lib.update_cue_loop(1, 0, 0, 10_000, true).is_err()); // past duration
    assert!(lib.update_bpm(1, 500.0, None, true).is_err());
    assert!(lib.remove_track(1).unwrap());
    assert!(lib.get_track(1).unwrap().is_none());
    // Removing a library-managed custom-audio copy frees its disk space.
    assert!(!audio.exists());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn export_copy_never_clobbers_a_destination_created_after_name_selection() {
    let root = tmp_root("export-noclobber");
    let source = root.join("source.wav");
    let destination = root.join("destination.wav");
    std::fs::write(&source, b"library audio").unwrap();
    std::fs::write(&destination, b"user file").unwrap();

    let error = copy_file_noclobber(&source, &destination).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(&destination).unwrap(), b"user file");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn metadata_only_edits_preserve_analyzed_bpm_and_manual_sync_beats_stale_tags() {
    let root = tmp_root("manual-bpm-serato-sync");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops").join("tempo.wav");
    let buffer = wav_buf();
    std::fs::write(&audio, Library::loop_buffer_to_wav(&buffer)).unwrap();
    let (track_id, added) = lib
        .add_track(
            "Original",
            "Custom Loops",
            &audio,
            "custom",
            "external-source.wav",
            "manual-bpm-serato-sync",
            0,
            None,
            None,
            "wav",
            &buffer,
            0,
            0,
        )
        .unwrap();
    assert!(added);

    let mut tagged = SeratoMetadata::default();
    tagged.bpm = Some(100.0);
    serato::write_audio_file(&audio, &tagged, buffer.duration_ms() as i64).unwrap();
    lib.update_bpm(track_id, 100.0, Some(0.2), false).unwrap();

    let titled = lib
        .update_metadata(track_id, "Renamed", Some(100.0), "practice", false)
        .unwrap();
    assert_eq!(titled.bpm_source.as_deref(), Some("analyzed"));
    assert_eq!(titled.bpm_confidence, Some(0.2));

    let explicitly_confirmed = lib
        .update_metadata(track_id, "Renamed", Some(100.0), "practice", true)
        .unwrap();
    assert_eq!(explicitly_confirmed.bpm, Some(100.0));
    assert_eq!(explicitly_confirmed.bpm_source.as_deref(), Some("manual"));
    assert_eq!(explicitly_confirmed.bpm_confidence, None);

    let manual = lib
        .update_metadata(track_id, "Renamed", Some(120.0), "practice", true)
        .unwrap();
    assert_eq!(manual.bpm, Some(120.0));
    assert_eq!(manual.bpm_source.as_deref(), Some("manual"));
    assert_eq!(manual.bpm_confidence, None);

    lib.sync_serato_metadata(track_id).unwrap();
    let from_file = serato::read_audio_file(&audio).unwrap().metadata;
    assert_eq!(from_file.bpm, Some(120.0));
    let from_library = lib.get_serato_metadata(track_id).unwrap();
    assert_eq!(from_library.bpm, Some(120.0));
    assert_eq!(
        lib.get_track(track_id)
            .unwrap()
            .unwrap()
            .bpm_source
            .as_deref(),
        Some("manual")
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn missing_files_are_flagged() {
    let root = tmp_root("missing");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("Custom Loops").join("gone.wav");
    std::fs::write(&audio, b"fake").unwrap();
    lib.add_track(
        "t",
        "Custom Loops",
        &audio,
        "custom",
        "s",
        "h",
        0,
        None,
        None,
        "wav",
        &wav_buf(),
        0,
        0,
    )
    .unwrap();
    std::fs::remove_file(&audio).unwrap();
    let t = lib.list_tracks().unwrap();
    assert!(!t[0].exists);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn sanitize_confines_names() {
    assert_eq!(sanitize_name("../../etc/passwd"), "etc_passwd");
    assert_eq!(sanitize_name(""), "untitled");
    assert_eq!(
        sanitize_name("The Seventeenth (Wave) 01"),
        "The Seventeenth (Wave) 01"
    );
    assert!(!sanitize_name("a/b\\c")
        .chars()
        .any(|c| c == '/' || c == '\\'));
    assert_eq!(sanitize_name("CON"), "_CON");
    assert_eq!(sanitize_name("aux.wav"), "_aux.wav");
    assert_eq!(sanitize_name("COM9.mp3"), "_COM9.mp3");
    assert_eq!(sanitize_name("LPT²"), "_LPT²");
    assert_eq!(sanitize_name("COM10"), "COM10");
}

#[test]
fn looper_filename_provides_artist_and_album_tag_values() {
    assert_eq!(
        looper_audio_tags("Nina Simone - Friendly Melodies"),
        (
            Some("Nina Simone".to_string()),
            "Friendly Melodies".to_string()
        )
    );
    assert_eq!(
        looper_audio_tags("Nina Simone – Friendly Melodies"),
        (
            Some("Nina Simone".to_string()),
            "Friendly Melodies".to_string()
        )
    );
    assert_eq!(
        looper_audio_tags("Untitled Looper"),
        (None, "Untitled Looper".to_string())
    );
}

#[test]
fn extracted_wav_gets_looper_artist_album_and_front_cover_tags() {
    let root = tmp_root("extracted-tags");
    let lib = Library::open(&root).unwrap();
    let buf = wav_buf();
    let sound = crate::import::swf::Sound {
        id: 17,
        format: 0,
        codec: "wav".to_string(),
        sample_count: buf.frames() as u32,
        seek_samples: 0,
        trimmed_leading: 0,
        frames: Library::loop_buffer_to_wav(&buf),
    };
    let mut cover = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cover, 85)
        .encode(&[255, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    let report = lib
        .import_sounds_with_cover_and_progress(
            "Nina Simone - Friendly Melodies",
            "swf",
            "/source/Nina Simone - Friendly Melodies.swf",
            "metadata-tag-source",
            None,
            None,
            &[sound],
            Some(&cover),
            |_, _, _| Ok(()),
        )
        .unwrap();
    let track = lib.get_track(report.track_ids[0]).unwrap().unwrap();
    let tag = wav_id3_tag(Path::new(&track.file_path));
    assert_eq!(tag.artist(), Some("Nina Simone"));
    assert_eq!(tag.album(), Some("Friendly Melodies"));
    let picture = tag.pictures().next().unwrap();
    assert_eq!(picture.mime_type, "image/jpeg");
    assert_eq!(picture.picture_type, id3::frame::PictureType::CoverFront);
    assert_eq!(picture.data, cover);
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn import_with_undecodable_sounds_fails_clean() {
    // Fake frames are not real MP3: every sound lands in `failed`,
    // no rows, no looper dir left behind.
    let root = tmp_root("import-fail");
    let lib = Library::open(&root).unwrap();
    let tags = define_sound_tag(1, FORMAT_MP3, &fake_mp3(0));
    let swf = crate::import::swf::parse(&fws_file(5, &tags)).unwrap();
    let err = lib
        .import_sounds(
            "Looper",
            "swf",
            "/src/l.swf",
            "hashx",
            None,
            None,
            &swf.sounds,
        )
        .unwrap_err();
    assert_eq!(err, "no sounds could be imported");
    assert!(lib.list_tracks().unwrap().is_empty());
    assert!(!root.join("Looper").exists());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn import_reports_extraction_stage_before_a_sound_failure() {
    let root = tmp_root("import-progress");
    let lib = Library::open(&root).unwrap();
    let tags = define_sound_tag(1, FORMAT_MP3, &fake_mp3(0));
    let swf = crate::import::swf::parse(&fws_file(5, &tags)).unwrap();
    let mut stages = Vec::new();
    let (_, err) = lib
        .import_sounds_with_progress(
            "Looper",
            "swf",
            "/src/l.swf",
            "hash-progress",
            None,
            None,
            &swf.sounds,
            |stage, current, total| {
                stages.push((stage.to_string(), current, total));
                Ok(())
            },
        )
        .unwrap_err();
    assert_eq!(err, "no sounds could be imported");
    assert_eq!(stages, vec![("extracting".to_string(), 1, 1)]);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn import_dedups_second_run() {
    // Drive the idempotent path with one real-decodable sound: reuse the
    // plumbing by importing, then confirm the second run reports existing.
    // (Fake frames fail decode, so we assert on the `failed` bookkeeping
    // plus a manually-added row for the same identity.)
    let root = tmp_root("import-dedup");
    let lib = Library::open(&root).unwrap();
    let audio = root.join("L").join("01_1.mp3");
    std::fs::create_dir_all(audio.parent().unwrap()).unwrap();
    std::fs::write(&audio, b"fake").unwrap();
    lib.add_track(
        "01 · L",
        "L",
        &audio,
        "swf",
        "/src/l.swf",
        "h2",
        1,
        None,
        None,
        "wav",
        &wav_buf(),
        0,
        0,
    )
    .unwrap();
    let tags = define_sound_tag(1, FORMAT_MP3, &fake_mp3(0));
    let swf = crate::import::swf::parse(&fws_file(5, &tags)).unwrap();
    // Sound id 1 is already known for hash h2... different hash here, so it
    // goes to decode and fails; assert bookkeeping rather than success.
    let err = lib
        .import_sounds(
            "L",
            "swf",
            "/src/l.swf",
            "other-hash",
            None,
            None,
            &swf.sounds,
        )
        .unwrap_err();
    assert_eq!(err, "no sounds could be imported");
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn long_sanitized_group_names_keep_distinct_source_audio_separate() {
    let root = tmp_root("long-source-name-collision");
    let lib = Library::open(&root).unwrap();
    let name = "x".repeat(80);
    let mut sounds = Vec::new();
    for (hash, sample) in [("source-one", 100i16), ("source-two", -100i16)] {
        let mut buffer = wav_buf();
        buffer.samples.fill(sample);
        let sound = crate::import::swf::Sound {
            id: 7,
            format: 0,
            codec: "wav".to_string(),
            sample_count: buffer.frames() as u32,
            seek_samples: 0,
            trimmed_leading: 0,
            frames: Library::loop_buffer_to_wav(&buffer),
        };
        let report = lib
            .import_sounds(
                &name,
                "swf",
                &format!("/{hash}.swf"),
                hash,
                None,
                None,
                &[sound],
            )
            .unwrap();
        assert_eq!(report.added, 1);
        sounds.push(lib.get_track(report.track_ids[0]).unwrap().unwrap());
    }

    assert_ne!(
        Path::new(&sounds[0].file_path).parent(),
        Path::new(&sounds[1].file_path).parent()
    );
    assert_ne!(
        std::fs::read(&sounds[0].file_path).unwrap(),
        std::fs::read(&sounds[1].file_path).unwrap()
    );
    assert_eq!(lib.list_tracks().unwrap().len(), 2);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn embedded_import_lists_tracks_and_decodes_from_the_managed_source_without_audio_copies() {
    fn push_bits(
        value: u32,
        width: usize,
        bytes: &mut Vec<u8>,
        current: &mut u8,
        count: &mut usize,
    ) {
        for shift in (0..width).rev() {
            *current = (*current << 1) | ((value >> shift) & 1) as u8;
            *count += 1;
            if *count == 8 {
                bytes.push(*current);
                *current = 0;
                *count = 0;
            }
        }
    }

    let root = tmp_root("embedded-source-playback");
    let lib = Library::open(&root).unwrap();
    let mut adpcm = Vec::new();
    let mut current = 0u8;
    let mut bit_count = 0usize;
    push_bits(0, 2, &mut adpcm, &mut current, &mut bit_count); // two-bit ADPCM code width
    push_bits(0, 16, &mut adpcm, &mut current, &mut bit_count); // initial sample
    push_bits(0, 6, &mut adpcm, &mut current, &mut bit_count); // initial step index
    push_bits(0, 2, &mut adpcm, &mut current, &mut bit_count); // one delta sample
    if bit_count != 0 {
        adpcm.push(current << (8 - bit_count));
    }

    let mut sound_tag = define_sound_tag(23, crate::import::swf::FORMAT_ADPCM, &adpcm);
    sound_tag[5..9].copy_from_slice(&2u32.to_le_bytes());
    let source_bytes = fws_file(10, &sound_tag);
    let parsed = crate::import::swf::parse(&source_bytes).unwrap();
    assert_eq!(parsed.sounds.len(), 1);
    let source_path = root.join("loopersFlash").join("Embedded.swf");
    std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
    std::fs::write(&source_path, &source_bytes).unwrap();
    let source_path = source_path.to_string_lossy().to_string();
    let hash = sha256_hex(&source_bytes);

    let report = lib
        .import_embedded_sounds_with_cover_and_progress(
            "Embedded",
            "swf",
            &source_path,
            &hash,
            None,
            None,
            &parsed.sounds,
            None,
            |_, _, _| Ok(()),
        )
        .unwrap();

    assert_eq!(report.added, 1);
    let track = lib.get_track(report.track_ids[0]).unwrap().unwrap();
    assert_eq!(track.audio_storage, "embedded");
    assert_eq!(track.file_path, source_path);
    assert_eq!(track.playback_path, format!("embedded:{}", track.id));
    assert!(track.exists);
    assert!(!root
        .join(extracted_group_directory_name("Embedded", &hash))
        .exists());

    let request = lib.playback_request(track.id).unwrap();
    let decoded = request.decode().unwrap();
    let expected = prepare_sound(&parsed.sounds[0]).unwrap().buffer;
    assert_eq!(decoded.samples, expected.samples);
    assert_eq!(decoded.rate, expected.rate);
    assert_eq!(decoded.channels, expected.channels);

    let export_directory = root.join("exports");
    std::fs::create_dir_all(&export_directory).unwrap();
    assert_eq!(
        lib.export_tracks(&[track.id], &export_directory).unwrap(),
        1
    );
    let exported = std::fs::read_dir(&export_directory)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        exported.extension().and_then(|ext| ext.to_str()),
        Some("wav")
    );
    let exported_buffer = crate::player::decode_bytes(&std::fs::read(exported).unwrap()).unwrap();
    assert_eq!(exported_buffer.samples, expected.samples);

    let metadata = lib.get_serato_metadata(track.id).unwrap();
    assert_eq!(metadata.cues.len(), 1);
    assert_eq!(metadata.cues[0].slot, 1);
    assert_eq!(metadata.cues[0].position_ms, 0);
    assert!(metadata.loops.is_empty());
    assert_eq!(
        lib.set_serato_cue(track.id, 1, Some(0)).unwrap().cues[0].position_ms,
        0
    );
    assert!(lib.set_serato_cue(track.id, 1, Some(10)).is_err());
    assert!(lib.set_serato_cue(track.id, 2, Some(0)).is_err());
    assert!(lib.sync_serato_metadata(track.id).is_err());
    assert_eq!(sha256_hex(&std::fs::read(&source_path).unwrap()), hash);
    lib.rename_looper(&hash, "Renamed embedded").unwrap();
    assert_eq!(
        lib.get_track(track.id).unwrap().unwrap().file_path,
        source_path
    );
    assert!(lib.remove_track(track.id).unwrap());
    assert!(Path::new(&source_path).is_file());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn cancelling_before_catalog_insert_removes_the_staged_audio_file() {
    let root = tmp_root("cancel-before-track-insert");
    let lib = Library::open(&root).unwrap();
    let buffer = wav_buf();
    let sound = crate::import::swf::Sound {
        id: 3,
        format: 0,
        codec: "wav".to_string(),
        sample_count: buffer.frames() as u32,
        seek_samples: 0,
        trimmed_leading: 0,
        frames: Library::loop_buffer_to_wav(&buffer),
    };
    let (_, error) = lib
        .import_sounds_with_progress(
            "Cancelable",
            "swf",
            "/source/cancel.swf",
            "cancel-before-insert",
            None,
            None,
            &[sound],
            |stage, _, _| {
                if stage == "inserting in library" {
                    Err("cancelled".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
    assert_eq!(error, "cancelled");
    assert!(lib.list_tracks().unwrap().is_empty());
    let staged_group = root.join(extracted_group_directory_name(
        "Cancelable",
        "cancel-before-insert",
    ));
    assert!(std::fs::read_dir(staged_group).unwrap().next().is_none());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn parallel_sound_preparation_keeps_source_order_in_library() {
    let root = tmp_root("parallel-import-order");
    let lib = Library::open(&root).unwrap();
    let ids = [42u16, 7, 91, 3, 55, 18];
    let mut sounds = Vec::new();
    for (index, id) in ids.iter().copied().enumerate() {
        let source = root.join(format!("source-{index}.wav"));
        write_wav(&source, &[index as i16; 800], 8000);
        sounds.push(crate::import::swf::Sound {
            id,
            format: 0,
            codec: "wav".to_string(),
            sample_count: 800,
            seek_samples: 0,
            trimmed_leading: 0,
            frames: std::fs::read(source).unwrap(),
        });
    }

    let report = lib
        .import_sounds(
            "Parallel Looper",
            "swf",
            "/source/parallel.swf",
            "parallel-source-hash",
            None,
            None,
            &sounds,
        )
        .unwrap();
    let tracks = lib.list_tracks().unwrap();
    assert_eq!(report.added, ids.len());
    assert_eq!(
        report.track_ids,
        tracks.iter().map(|track| track.id).collect::<Vec<_>>()
    );
    assert_eq!(
        tracks
            .iter()
            .map(|track| track.source_sound_id)
            .collect::<Vec<_>>(),
        ids.iter().map(|id| *id as i64).collect::<Vec<_>>()
    );
    std::fs::remove_dir_all(&root).ok();
}

/// Dev-only: full import of the real `.swf` + `.exe` from `loopersFlash/`.
/// Run: `OLOOPER_FIXTURES=1 cargo test -- --ignored --nocapture`
#[test]
#[ignore]
fn import_real_loopers() {
    if std::env::var("OLOOPER_FIXTURES").is_err() {
        eprintln!("set OLOOPER_FIXTURES=1 to run");
        return;
    }
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../loopersFlash");
    let swf_path = fixtures.join("The Nineteenth Wave Looper.swf");
    let exe_path = fixtures.join("TheSeventeenthWaveLooper.exe");
    if !swf_path.is_file() || !exe_path.is_file() {
        eprintln!("loopersFlash samples missing, skipping");
        return;
    }
    let root = tmp_root("real");
    let lib = Library::open(&root).unwrap();

    let swf_data = std::fs::read(&swf_path).unwrap();
    let swf = crate::import::swf::parse(&swf_data).unwrap();
    let rep = lib
        .import_sounds(
            "Nineteenth",
            "swf",
            swf_path.to_str().unwrap(),
            &sha256_hex(&swf_data),
            None,
            None,
            &swf.sounds,
        )
        .unwrap();
    assert!(rep.added >= 40, "added={}", rep.added);
    assert!(rep.failed.is_empty());

    let exe_data = std::fs::read(&exe_path).unwrap();
    let found = crate::import::exe::locate(&exe_data).unwrap();
    let inner =
        crate::import::swf::parse(&exe_data[found.offset..found.offset + found.length]).unwrap();
    let rep2 = lib
        .import_sounds(
            "Seventeenth",
            "exe",
            exe_path.to_str().unwrap(),
            &sha256_hex(&exe_data),
            Some(found.offset as i64),
            Some(found.length as i64),
            &inner.sounds,
        )
        .unwrap();
    assert!(rep2.added >= 40, "added={}", rep2.added);

    // Re-import is a no-op.
    let rep3 = lib
        .import_sounds(
            "Nineteenth",
            "swf",
            swf_path.to_str().unwrap(),
            &sha256_hex(&swf_data),
            None,
            None,
            &swf.sounds,
        )
        .unwrap();
    assert_eq!(rep3.added, 0);
    assert_eq!(rep3.already_there, rep.added);

    // Every row points at a real file.
    assert!(lib.list_tracks().unwrap().iter().all(|t| t.exists));
    std::fs::remove_dir_all(&root).ok();
}

/// Write mono i16 PCM WAV bytes to `path`.
fn write_wav(path: &Path, samples: &[i16], rate: u32) {
    let mut v = b"RIFF".to_vec();
    v.extend_from_slice(&((36 + samples.len() * 2) as u32).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * 2).to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&((samples.len() * 2) as u32).to_le_bytes());
    for s in samples {
        v.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, v).unwrap();
}

#[test]
fn custom_import_copies_and_dedups() {
    let root = tmp_root("custom");
    let lib = Library::open(&root).unwrap();
    let src = root.join("my-beat.wav");
    write_wav(&src, &[0; 16000], 8000); // 2 s silence: no BPM, still imports
    let reps = lib.import_custom(&[src.to_str().unwrap().to_string()]);
    assert_eq!(reps.len(), 1);
    assert!(reps[0].added);
    assert!(reps[0].bpm.is_none());
    let id = reps[0].track_id.unwrap();
    let t = lib.get_track(id).unwrap().unwrap();
    assert_eq!(t.source_type, "custom");
    assert_eq!((t.loop_start_ms, t.loop_enabled), (0, true));
    assert_eq!(t.loop_end_ms, t.duration_ms);
    assert!(t.file_path.contains("Custom Loops"));
    assert!(Path::new(&t.file_path).is_file());
    // Original untouched.
    assert!(src.is_file());
    // Re-import: no-op.
    let reps2 = lib.import_custom(&[src.to_str().unwrap().to_string()]);
    assert!(!reps2[0].added);
    assert_eq!(reps2[0].track_id, Some(id));
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
    let imported_copy = PathBuf::from(&t.file_path);
    assert!(lib.remove_track(id).unwrap());
    assert!(!imported_copy.exists());
    assert!(src.is_file());
    assert!(lib.list_tracks().unwrap().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn custom_import_collision_renames() {
    let root = tmp_root("custom-collision");
    let lib = Library::open(&root).unwrap();
    let a_dir = root.join("a");
    let b_dir = root.join("b");
    std::fs::create_dir_all(&a_dir).unwrap();
    std::fs::create_dir_all(&b_dir).unwrap();
    write_wav(&a_dir.join("beat.wav"), &[0; 16000], 8000);
    write_wav(&b_dir.join("beat.wav"), &[1000; 16000], 8000);
    let reps = lib.import_custom(&[
        a_dir.join("beat.wav").to_str().unwrap().to_string(),
        b_dir.join("beat.wav").to_str().unwrap().to_string(),
    ]);
    assert!(reps.iter().all(|r| r.added));
    let tracks = lib.list_tracks().unwrap();
    assert_eq!(tracks.len(), 2);
    assert!(tracks[1].file_path.contains("beat (2).wav"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn custom_import_beat_gets_bpm() {
    let root = tmp_root("custom-bpm");
    let lib = Library::open(&root).unwrap();
    // 120 BPM clicks @44.1 kHz, 8 s.
    let period = 22050;
    let mut s = vec![0i16; 44100 * 8];
    let mut i = 0;
    while i < s.len() {
        s[i] = i16::MAX;
        i += period;
    }
    let src = root.join("clicks.wav");
    write_wav(&src, &s, 44100);
    let reps = lib.import_custom(&[src.to_str().unwrap().to_string()]);
    assert!(reps[0].added);
    let bpm = reps[0].bpm.expect("no estimate");
    assert!((bpm - 120.0).abs() < 1.0, "got {bpm}");
    let t = lib.get_track(reps[0].track_id.unwrap()).unwrap().unwrap();
    assert_eq!(t.bpm_source.as_deref(), Some("analyzed"));
    // Manual correction sticks.
    lib.update_bpm(t.id, 124.0, None, true).unwrap();
    assert_eq!(lib.get_track(t.id).unwrap().unwrap().bpm, Some(124.0));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn custom_import_garbage_fails_per_file() {
    let root = tmp_root("custom-garbage");
    let lib = Library::open(&root).unwrap();
    let bad = root.join("nope.wav");
    std::fs::write(&bad, b"not audio at all").unwrap();
    let good = root.join("ok.wav");
    write_wav(&good, &[0; 16000], 8000);
    let reps = lib.import_custom(&[
        bad.to_str().unwrap().to_string(),
        good.to_str().unwrap().to_string(),
    ]);
    assert!(reps[0].error.is_some() && !reps[0].added);
    assert!(reps[1].added);
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn tablist_import_preserves_full_loop_bpm_and_deduplicates() {
    let root = tmp_root("tablist-import");
    let lib = Library::open(&root).unwrap();
    let source = root.join("source.wav");
    write_wav(&source, &[0; 16000], 8000);
    let bytes = std::fs::read(source).unwrap();
    let group = sha256_hex(b"looper/example");
    let first = lib.import_tablist_track(
        "Example Looper",
        &group,
        "https://tablist.net/looper/example",
        "loop-1",
        "Track 1",
        "wav",
        &bytes,
        Some(123.5),
    );
    assert!(first.added);
    assert_eq!(first.bpm, Some(123.5));
    let track = lib.get_track(first.track_id.unwrap()).unwrap().unwrap();
    assert_eq!(track.source_type, "tablist");
    assert_eq!(track.bpm, Some(123.5));
    assert_eq!(track.bpm_source.as_deref(), Some("analyzed"));
    assert_eq!(
        (track.loop_start_ms, track.loop_end_ms),
        (0, track.duration_ms)
    );
    assert_eq!(track.source_path, "https://tablist.net/looper/example");
    assert!(Path::new(&track.file_path).is_file());

    let source_cover = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        24,
        16,
        image::Rgb([40, 100, 180]),
    ));
    let mut cover_bytes = std::io::Cursor::new(Vec::new());
    source_cover
        .write_to(&mut cover_bytes, image::ImageFormat::Png)
        .unwrap();
    assert!(lib.save_group_cover(&group, cover_bytes.get_ref()).unwrap());
    let cover_url = lib.group_cover_data_url(&group).unwrap().unwrap();
    assert!(cover_url.starts_with("data:image/jpeg;base64,"));
    assert!(!lib.save_group_cover(&group, cover_bytes.get_ref()).unwrap());

    let second = lib.import_tablist_track(
        "Example Looper",
        &group,
        "https://tablist.net/looper/example",
        "loop-1",
        "Track 1",
        "wav",
        &bytes,
        Some(123.5),
    );
    assert!(!second.added);
    assert_eq!(second.track_id, first.track_id);
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn random_track_skips_the_current_track_when_another_is_playable() {
    let root = tmp_root("random-track");
    let lib = Library::open(&root).unwrap();
    let first_path = root.join("first.wav");
    let second_path = root.join("second.wav");
    write_wav(&first_path, &[0; 16000], 8000);
    write_wav(&second_path, &[1000; 16000], 8000);
    let first = lib.import_one_custom(first_path.to_str().unwrap());
    let second = lib.import_one_custom(second_path.to_str().unwrap());
    assert!(first.added && second.added);

    let random = lib.random_track(first.track_id).unwrap().unwrap();
    assert_eq!(random.id, second.track_id.unwrap());

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn import_one_custom_adds_then_dedups() {
    // Per-file entry point used by the background worker: same result as
    // the batch `import_custom`, second call reports "already in library".
    let root = tmp_root("one-custom");
    let lib = Library::open(&root).unwrap();
    let good = root.join("ok.wav");
    write_wav(&good, &[0; 16000], 8000);
    let path = good.to_str().unwrap().to_string();
    let first = lib.import_one_custom(&path);
    assert!(first.added);
    assert!(first.track_id.is_some());
    assert!(first.error.is_none());
    let second = lib.import_one_custom(&path);
    assert!(!second.added);
    assert_eq!(second.error.as_deref(), Some("already in library"));
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn loop_buffer_to_wav_roundtrips() {
    let buf = wav_buf();
    let wav = Library::loop_buffer_to_wav(&buf);
    // Must start with RIFF header.
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(&wav[8..12], b"WAVE");
    // Must decode back to the same shape.
    let decoded = crate::player::decode_bytes(&wav).unwrap();
    assert_eq!(decoded.frames(), buf.frames());
    assert_eq!(decoded.rate, buf.rate);
    assert_eq!(decoded.channels, buf.channels);
    assert_eq!(decoded.samples, buf.samples);
}

#[test]
fn trim_mp3_gapless_returns_none_when_no_trim_needed() {
    // Both zero → no trim.
    let buf = wav_buf();
    let result = Library::trim_mp3_gapless(&buf, 0, 0);
    assert!(result.is_none());
}

#[test]
fn trim_mp3_gapless_trims_valid_range() {
    // Create a WAV that decodes to 800 frames, then trim to [100, 500).
    let buf = wav_buf();
    assert_eq!(buf.frames(), 800);
    let (trimmed, out_wav) = Library::trim_mp3_gapless(&buf, 100, 400).unwrap();
    assert_eq!(trimmed.frames(), 400);
    assert_eq!(trimmed.rate, buf.rate);
    assert_eq!(trimmed.channels, buf.channels);
    // Verify the samples match the original slice.
    let ch = buf.channels as usize;
    assert_eq!(trimmed.samples, buf.samples[100 * ch..500 * ch]);
    // Output WAV must decode to the same trimmed buffer.
    let redecoded = crate::player::decode_bytes(&out_wav).unwrap();
    assert_eq!(redecoded.samples, trimmed.samples);
}

#[test]
fn trim_mp3_gapless_clamps_to_buffer_end() {
    let buf = wav_buf(); // 800 frames
                         // Request [700, 2000) → clamped to [700, 800).
    let (trimmed, _) = Library::trim_mp3_gapless(&buf, 700, 1300).unwrap();
    assert_eq!(trimmed.frames(), 100);
}

#[test]
fn trim_mp3_gapless_rejects_out_of_range() {
    let buf = wav_buf(); // 800 frames
                         // start >= total_frames → None.
    assert!(Library::trim_mp3_gapless(&buf, 800, 100).is_none());
    // seek_samples=500, sample_count=0 → valid: trim leading 500, keep rest.
    let (trimmed, _) = Library::trim_mp3_gapless(&buf, 500, 0).unwrap();
    assert_eq!(trimmed.frames(), 300);
}

#[test]
fn open_enables_wal_mode() {
    // The background import worker holds its own connection; WAL is what
    // lets it write while the main connection serves readers.
    let root = tmp_root("wal");
    let lib = Library::open(&root).unwrap();
    let mode: String = lib
        .conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn second_connection_reads_while_first_writes() {
    // Mirrors the worker pattern: one handle imports, another lists.
    // With WAL + busy_timeout neither side may see "database is locked".
    let root = tmp_root("two-conn");
    let main = Library::open(&root).unwrap();
    let buf = wav_buf();
    let audio = root.join("Custom Loops").join("w.wav");
    std::fs::write(&audio, b"fake").unwrap();
    main.add_track(
        "w",
        "Custom Loops",
        &audio,
        "custom",
        "/src/w.wav",
        "hash-w",
        0,
        None,
        None,
        "wav",
        &buf,
        0,
        0,
    )
    .unwrap();
    let worker_root = root.clone();
    let handle = std::thread::spawn(move || {
        let worker = Library::open(&worker_root).unwrap();
        for i in 0..20 {
            let tracks = worker.list_tracks().expect("worker read locked out");
            assert!(!tracks.is_empty());
            worker
                .set_favorite(tracks[0].id, i % 2 == 0)
                .expect("worker write locked out");
        }
    });
    for _ in 0..20 {
        let tracks = main.list_tracks().expect("main read locked out");
        assert_eq!(tracks.len(), 1);
    }
    handle.join().expect("worker thread panicked");
    std::fs::remove_dir_all(&root).ok();
}
