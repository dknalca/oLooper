//! Hardware-free catalog operation counts and Random selection regressions.

use super::*;
use std::cell::Cell;

fn add_track(lib: &Library, path: &Path, hash: &str, sound: i64, embedded: bool) -> i64 {
    lib.add_track_with_storage(
        &format!("Track {hash}/{sound}"),
        "Catalog test",
        path,
        if embedded { "swf" } else { "custom" },
        path.to_str().unwrap(),
        hash,
        sound,
        None,
        None,
        "wav",
        &crate::player::LoopBuffer {
            samples: vec![1, 2, 3, 4],
            channels: 1,
            rate: 8000,
        },
        0,
        0,
        if embedded { "embedded" } else { "extracted" },
        false,
    )
    .unwrap()
    .0
}

#[test]
fn catalog_queries_share_positive_and_negative_source_checks() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let present = root.path().join("shared.swf");
    let missing = root.path().join("missing.exe");
    std::fs::write(&present, b"catalog fixture, never executed").unwrap();
    for sound in 0..64 {
        let path = if sound % 2 == 0 { &present } else { &missing };
        add_track(&lib, path, "shared", sound, true);
    }
    let mut checks = BTreeMap::<String, usize>::new();
    let mut availability = FileAvailability::new(|path: &str| {
        *checks.entry(path.to_string()).or_default() += 1;
        Path::new(path).is_file()
    });
    let tracks = lib
        .query_tracks_with_availability(None, None, &mut availability)
        .unwrap();
    assert_eq!(tracks.len(), 64);
    assert!(tracks.windows(2).all(|pair| pair[0].id < pair[1].id));
    for track in &tracks {
        assert_eq!(track.exists, track.source_sound_id % 2 == 0);
        assert_eq!(track.playback_path, format!("embedded:{}", track.id));
    }
    assert_eq!(checks.len(), 2);
    assert!(checks.values().all(|count| *count == 1));
    assert_eq!(tracks, lib.list_tracks().unwrap());
}

#[test]
fn catalog_point_lookups_probe_only_the_selected_row() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let selected = root.path().join("selected.wav");
    let id = add_track(&lib, &selected, "selected", 0, false);
    add_track(&lib, &root.path().join("unrelated.wav"), "other", 0, false);
    let calls = Cell::new(0);
    let mut availability = FileAvailability::new(|path: &str| {
        assert_eq!(Path::new(path), selected);
        calls.set(calls.get() + 1);
        false
    });
    assert_eq!(
        lib.query_tracks_with_availability(Some(id), None, &mut availability)
            .unwrap()[0]
            .id,
        id
    );
    assert!(lib
        .query_tracks_with_availability(Some(id), Some("other"), &mut availability)
        .unwrap()
        .is_empty());
    assert_eq!(calls.get(), 1);
}

#[test]
fn availability_is_fresh_between_calls_and_playback_rechecks_the_source() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let source = root.path().join("external.swf");
    let id = add_track(&lib, &source, "source", 1, true);
    assert!(!lib.list_tracks().unwrap()[0].exists);
    std::fs::write(&source, b"never executed").unwrap();
    assert!(lib.list_tracks().unwrap()[0].exists);
    std::fs::remove_file(&source).unwrap();
    assert!(lib.playback_request(id).unwrap_err().contains("missing"));
    assert!(!lib.get_track(id).unwrap().unwrap().exists);
    std::fs::create_dir(&source).unwrap();
    assert!(!lib.list_tracks().unwrap()[0].exists);
    std::fs::remove_dir(&source).unwrap();
    std::fs::write(&source, b"restored").unwrap();
    assert!(lib.get_track(id).unwrap().unwrap().exists);
    assert_eq!(lib.list_tracks().unwrap().len(), 1);
}

#[test]
fn random_probes_only_the_chosen_candidate_in_a_healthy_catalog() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let source = root.path().join("source.swf");
    std::fs::write(&source, b"never executed").unwrap();
    let ids: Vec<_> = (0..256)
        .map(|sound| add_track(&lib, &source, "shared", sound, true))
        .collect();
    let calls = Cell::new(0);
    let track = lib
        .random_track_with(
            None,
            None,
            |count| {
                assert_eq!(count, ids.len());
                Ok(127)
            },
            |path: &str| {
                calls.set(calls.get() + 1);
                Path::new(path).is_file()
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(calls.get(), 1);
    assert_eq!(track, lib.get_track(ids[127]).unwrap().unwrap());
}

#[test]
fn random_does_not_hydrate_missing_or_unselected_track_metadata() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let present = root.path().join("present.wav");
    std::fs::write(&present, b"present").unwrap();
    let missing = add_track(&lib, &root.path().join("missing.wav"), "missing", 0, false);
    let unselected = add_track(&lib, &present, "unselected", 0, false);
    let selected = add_track(&lib, &present, "selected", 0, false);
    // Deliberately unreadable DTO fields prove that neither unrelated metadata
    // nor a missing candidate is hydrated. Ordinary listing still reports it.
    lib.conn
        .execute(
            "UPDATE tracks SET title=x'00ff' WHERE id IN (?1,?2)",
            rusqlite::params![missing, unselected],
        )
        .unwrap();
    assert!(lib.list_tracks().is_err());
    // Removing the first candidate swaps the last (selected) candidate into 0.
    let track = lib
        .random_track_with(
            None,
            None,
            |_| Ok(0),
            |path: &str| Path::new(path).is_file(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(track.id, selected);
}

#[test]
fn random_checks_missing_shared_sources_once_and_keeps_current_as_fallback() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let current = root.path().join("current.wav");
    let missing = root.path().join("missing.swf");
    std::fs::write(&current, b"current").unwrap();
    let current_id = add_track(&lib, &current, "current", 0, false);
    for sound in 0..32 {
        add_track(&lib, &missing, "missing", sound, true);
    }
    let mut checks = BTreeMap::<String, usize>::new();
    let track = lib
        .random_track_with(
            Some(current_id),
            None,
            |_| Ok(0),
            |path: &str| {
                *checks.entry(path.to_string()).or_default() += 1;
                Path::new(path).is_file()
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(track.id, current_id);
    assert_eq!(checks.len(), 2);
    assert!(checks.values().all(|count| *count == 1));
    std::fs::remove_file(&current).unwrap();
    assert!(lib.random_track(Some(current_id), None).unwrap().is_none());
    std::fs::write(&missing, b"restored source").unwrap();
    assert_ne!(
        lib.random_track(Some(current_id), None)
            .unwrap()
            .unwrap()
            .id,
        current_id
    );
    assert_eq!(lib.list_tracks().unwrap().len(), 33);
}

#[test]
fn random_draws_do_not_bias_playable_tracks_toward_missing_neighbors() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let mut ids = Vec::new();
    for index in 0..3 {
        let source = root.path().join(format!("{index}.wav"));
        if index != 1 {
            std::fs::write(&source, b"present").unwrap();
        }
        ids.push(add_track(&lib, &source, &index.to_string(), 0, false));
    }
    let mut counts = BTreeMap::<i64, usize>::new();
    // Enumerate all six equally likely first/second index draws, not a flaky
    // statistical sample. The missing middle ID must favor neither neighbor.
    for first in 0..3 {
        for second in 0..2 {
            let mut choices = [first, second].into_iter();
            let chosen = lib
                .random_track_with(
                    None,
                    None,
                    |_| Ok(choices.next().unwrap()),
                    |path: &str| Path::new(path).is_file(),
                )
                .unwrap()
                .unwrap();
            *counts.entry(chosen.id).or_default() += 1;
        }
    }
    assert_eq!(counts, BTreeMap::from([(ids[0], 3), (ids[2], 3)]));
}

#[test]
fn random_weights_embedded_tracks_individually_not_per_container() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    let shared = root.path().join("shared.swf");
    let other = root.path().join("other.swf");
    std::fs::write(&shared, b"shared").unwrap();
    std::fs::write(&other, b"other").unwrap();
    let ids = [
        add_track(&lib, &shared, "shared", 1, true),
        add_track(&lib, &shared, "shared", 2, true),
        add_track(&lib, &other, "other", 1, true),
    ];
    for (index, id) in ids.into_iter().enumerate() {
        let track = lib
            .random_track_with(
                None,
                None,
                |_| Ok(index),
                |path: &str| Path::new(path).is_file(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(track.id, id);
    }
}

#[test]
fn random_rechecks_scope_and_deleted_rows_after_the_id_scan() {
    for remove in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let lib = Library::open(root.path()).unwrap();
        let source = root.path().join("source.swf");
        std::fs::write(&source, b"never executed").unwrap();
        let stale = add_track(&lib, &source, "scope", 1, true);
        let valid = add_track(&lib, &source, "scope", 2, true);
        let writer = Connection::open(root.path().join("olooper.db")).unwrap();
        let mut first = true;
        let track = lib
            .random_track_with(
                None,
                Some("scope"),
                |_| {
                    if first {
                        first = false;
                        let sql = if remove {
                            "DELETE FROM tracks WHERE id=?1"
                        } else {
                            "UPDATE tracks SET source_hash='other' WHERE id=?1"
                        };
                        writer.execute(sql, [stale]).unwrap();
                    }
                    Ok(0)
                },
                |path: &str| Path::new(path).is_file(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(track.id, valid);
        assert_eq!(track.source_hash, "scope");
    }
}

#[test]
fn random_empty_scope_never_falls_back_to_an_out_of_scope_current_track() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    assert!(lib.random_track(None, None).unwrap().is_none());
    let source = root.path().join("source.wav");
    std::fs::write(&source, b"present").unwrap();
    let id = add_track(&lib, &source, "other", 0, false);
    assert!(lib.random_track(Some(id), Some("empty")).unwrap().is_none());
    assert_eq!(
        lib.random_track(Some(id), Some("other"))
            .unwrap()
            .unwrap()
            .id,
        id
    );
}

#[test]
fn random_propagates_selection_errors_instead_of_repeating_the_current_track() {
    let root = tempfile::tempdir().unwrap();
    let lib = Library::open(root.path()).unwrap();
    add_track(&lib, &root.path().join("source.wav"), "scope", 0, false);
    let error = lib
        .random_track_with(
            None,
            None,
            |_| Err("random query failed".into()),
            |_: &str| panic!("must not probe after a selection error"),
        )
        .unwrap_err();
    assert_eq!(error, "random query failed");
}
