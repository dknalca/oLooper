//! Serialized command boundary, real SQLite/files, mock window and no audio device.
use super::*;
use serde_json::json;

#[test]
fn ipc_catalog_switch_and_concurrent_cue_updates_are_isolated() {
    let root = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_builder()
        .manage(player::spawn())
        .manage(Mutex::new(None::<library::Library>))
        .manage(bpm_jobs::BpmJobs::default())
        .invoke_handler(tauri::generate_handler![
            library_init,
            library_list,
            library_analyze_bpm,
            library_get_serato_metadata,
            library_set_serato_cue,
            library_random_track,
            player_status,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |command: &str, body: serde_json::Value| {
        tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .unwrap()
        .deserialize::<serde_json::Value>()
        .unwrap()
    };
    invoke("library_init", json!({ "root": root.path().join("a") }));
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&16036u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8000u32.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.resize(16044, 0);
    for beat in 0..4 {
        let offset = 44 + beat * 2000 * 2;
        wav[offset..offset + 2].copy_from_slice(&30000i16.to_le_bytes());
    }
    let source = root.path().join("source.wav");
    std::fs::write(&source, wav).unwrap();
    let id = {
        let state = app.state::<Mutex<Option<library::Library>>>();
        let guard = state.lock().unwrap();
        let library = guard.as_ref().unwrap();
        let id = library
            .import_one_custom(source.to_str().unwrap())
            .track_id
            .unwrap();
        library.update_cue_loop(id, 0, 0, 500, true).unwrap();
        id
    };
    let catalog_before_preview = invoke("library_list", json!({}));
    let audio_path = catalog_before_preview[0]["file_path"].as_str().unwrap();
    let audio_before_preview = std::fs::read(audio_path).unwrap();
    let suggestion = invoke("library_analyze_bpm", json!({ "id": id }));
    assert_eq!(suggestion["track_id"], id);
    assert_eq!(suggestion["bpm"], 240.0);
    assert_eq!(suggestion["bars"], 1);
    assert_eq!(suggestion["duration_frames"], 8000);
    assert_eq!(suggestion["sample_rate"], 8000);
    assert_eq!(suggestion["assumed_meter"], "4/4");
    assert_eq!(invoke("library_list", json!({})), catalog_before_preview);
    assert_eq!(std::fs::read(audio_path).unwrap(), audio_before_preview);
    assert_eq!(invoke("player_status", json!({}))["loaded"], false);
    invoke("library_get_serato_metadata", json!({ "trackId": id }));
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            invoke(
                "library_set_serato_cue",
                json!({ "trackId": id, "slot": 2, "positionMs": 200 }),
            )
        });
        let second = scope.spawn(|| {
            invoke(
                "library_set_serato_cue",
                json!({ "trackId": id, "slot": 3, "positionMs": 300 }),
            )
        });
        first.join().unwrap();
        second.join().unwrap();
    });
    let cues = invoke("library_get_serato_metadata", json!({ "trackId": id }));
    for slot in [2, 3] {
        assert!(cues["cues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|cue| cue["slot"] == slot));
    }
    invoke("library_init", json!({ "root": root.path().join("b") }));
    assert_eq!(invoke("library_list", json!({})), json!([]));
    assert_eq!(
        invoke(
            "library_random_track",
            json!({ "excludeId": null, "sourceHash": null })
        ),
        json!(null)
    );
    assert_eq!(invoke("player_status", json!({}))["loaded"], false);
}
