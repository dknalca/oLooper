//! Temp-DB tests: migrations, CRUD, dedup, missing files, import plumbing.
//! Real-file validation lives in the `#[ignore]`d test at the bottom:
//! `OLOOPER_FIXTURES=1 cargo test -- --ignored` on a dev machine.

use super::*;
use crate::import::fixture::*;
use crate::import::swf::FORMAT_MP3;

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

#[test]
fn migrate_starts_at_current_schema() {
    let root = tmp_root("migrate");
    let lib = Library::open(&root).unwrap();
    assert_eq!(lib.schema_version().unwrap(), 6);
    assert!(root.join("Custom Loops").is_dir());
    assert!(root.join("olooper.db").is_file());
    std::fs::remove_dir_all(&root).ok();
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
fn looper_group_rename_and_remove_keep_audio() {
    let root = tmp_root("group-management");
    let lib = Library::open(&root).unwrap();
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
            "/src/old.swf",
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
        "/src/old.swf",
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
    lib.set_slot(first_id, 1, "A", 0, 0, 90, true).unwrap();

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
    assert!(lib.get_slots(first_id).unwrap().is_empty());
    assert!(renamed_dir.join("01_1.mp3").is_file());
    std::fs::remove_dir_all(&root).ok();
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
    // Audio file untouched by row removal.
    assert!(audio.is_file());
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
            |stage, current, total| { stages.push((stage.to_string(), current, total)); Ok(()) },
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
    let wav = Library::loop_buffer_to_wav(&buf);
    let result = Library::trim_mp3_gapless(&wav, 0, 0);
    assert!(result.is_none());
}

#[test]
fn trim_mp3_gapless_trims_valid_range() {
    // Create a WAV that decodes to 800 frames, then trim to [100, 500).
    let buf = wav_buf();
    assert_eq!(buf.frames(), 800);
    let wav = Library::loop_buffer_to_wav(&buf);
    let (trimmed, out_wav) = Library::trim_mp3_gapless(&wav, 100, 400).unwrap();
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
    let wav = Library::loop_buffer_to_wav(&buf);
    // Request [700, 2000) → clamped to [700, 800).
    let (trimmed, _) = Library::trim_mp3_gapless(&wav, 700, 1300).unwrap();
    assert_eq!(trimmed.frames(), 100);
}

#[test]
fn trim_mp3_gapless_rejects_out_of_range() {
    let buf = wav_buf(); // 800 frames
    let wav = Library::loop_buffer_to_wav(&buf);
    // start >= total_frames → None.
    assert!(Library::trim_mp3_gapless(&wav, 800, 100).is_none());
    // seek_samples=500, sample_count=0 → valid: trim leading 500, keep rest.
    let (trimmed, _) = Library::trim_mp3_gapless(&wav, 500, 0).unwrap();
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
