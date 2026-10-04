use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter as _;
use tauri::Manager as _;

static CANCELLED_IMPORTS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn import_cancelled(job_id: &str) -> bool {
    CANCELLED_IMPORTS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .map(|jobs| jobs.contains(job_id))
        .unwrap_or(false)
}

fn import_unmark_cancelled(job_id: &str) {
    if let Ok(mut jobs) = CANCELLED_IMPORTS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
    {
        jobs.remove(job_id);
    }
}

pub mod analysis;
pub mod autoloop;
pub mod import;
pub mod library;
pub mod midi;
pub mod player;
pub mod tablist;
pub mod waveform;

/// Typed status DTO exposed to the frontend via `get_app_status`.
/// Keep in sync with `src/tauri.ts` `AppStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppStatus {
    pub version: String,
    pub platform: String,
    pub library_set: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ImportProgress {
    job_id: String,
    stage: String,
    current: usize,
    total: usize,
    detail: String,
    done: bool,
    error: Option<String>,
    /// Present only on the final `done` event of worker-run imports, so the
    /// frontend can update counts without awaiting the command. Keep in sync
    /// with `src/tauri.ts` `ImportProgress`.
    report: Option<library::ImportReport>,
    /// Same, for custom-audio jobs (per-file results).
    custom_report: Option<Vec<library::CustomReport>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedLibraryRoot {
    root: String,
}

fn portable_root_for_executable(
    executable: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if let Some(bundle) = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
    {
        return bundle
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| "app bundle has no parent directory".to_string());
    }
    executable
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| "executable has no parent directory".to_string())
}

fn portable_root() -> Result<std::path::PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|e| format!("cannot locate executable: {e}"))?;
    portable_root_for_executable(&executable)
}

fn suggested_library_root(home: &std::path::Path) -> std::path::PathBuf {
    home.join("Documents").join("oLooper_data")
}

fn legacy_library_selection_path() -> Result<std::path::PathBuf, String> {
    Ok(portable_root()?.join("olooper-library.json"))
}

/// Read and remove the selection file written beside the app by older builds.
/// New builds persist the selected path as an application preference instead.
fn take_legacy_library_root() -> Result<Option<String>, String> {
    let path = legacy_library_selection_path()?;
    take_legacy_library_root_from(&path)
}

fn take_legacy_library_root_from(path: &std::path::Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&path).map_err(|e| format!("cannot read library selection: {e}"))?;
    let saved: SavedLibraryRoot =
        serde_json::from_slice(&data).map_err(|e| format!("cannot read library selection: {e}"))?;
    std::fs::remove_file(&path)
        .map_err(|e| format!("cannot remove old library selection file: {e}"))?;
    Ok(Some(saved.root))
}

fn emit_import_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    stage: &str,
    current: usize,
    total: usize,
    detail: impl Into<String>,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "olooper:import-progress",
        ImportProgress {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            current,
            total,
            detail: detail.into(),
            done,
            error,
            report: None,
            custom_report: None,
        },
    );
}

/// Final event of a worker-run import: carries the report so fire-and-forget
/// commands still give the frontend per-file counts.
fn emit_import_done(
    app: &tauri::AppHandle,
    job_id: &str,
    current: usize,
    total: usize,
    detail: impl Into<String>,
    report: Option<library::ImportReport>,
    custom_report: Option<Vec<library::CustomReport>>,
) {
    let _ = app.emit(
        "olooper:import-progress",
        ImportProgress {
            job_id: job_id.to_string(),
            stage: "complete".to_string(),
            current,
            total,
            detail: detail.into(),
            done: true,
            error: None,
            report,
            custom_report,
        },
    );
}

fn copy_dropped_source(root: &std::path::Path, path: &str, data: &[u8]) -> Result<String, String> {
    let source_dir = root.join("loopersFlash");
    std::fs::create_dir_all(&source_dir)
        .map_err(|e| format!("cannot create loopersFlash inside the selected library: {e}"))?;
    copy_dropped_source_to(&source_dir, path, data)
}

fn copy_dropped_source_to(
    source_dir: &std::path::Path,
    path: &str,
    data: &[u8],
) -> Result<String, String> {
    let source = std::path::Path::new(path);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("looper");
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "swf" | "exe") {
        return Err("only .swf and .exe files can be copied to loopersFlash".to_string());
    }
    let stem = library::sanitize_name(stem);
    for n in 1..10_000 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!(" ({n})")
        };
        let dest = source_dir.join(format!("{stem}{suffix}.{ext}"));
        if dest.exists() {
            if std::fs::read(&dest).ok().as_deref() == Some(data) {
                return Ok(dest.to_string_lossy().to_string());
            }
            continue;
        }
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut tmp = tempfile::NamedTempFile::new_in(source_dir)
            .map_err(|e| format!("cannot create temporary source copy: {e}"))?;
        tmp.write_all(data)
            .and_then(|_| tmp.as_file_mut().sync_all())
            .and_then(|_| tmp.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|e| format!("cannot copy source: {e}"))?;
        let mut verified = Vec::new();
        tmp.read_to_end(&mut verified)
            .map_err(|e| format!("cannot verify source copy: {e}"))?;
        if verified != data {
            return Err("cannot verify source copy".to_string());
        }
        match tmp.persist_noclobber(&dest) {
            Ok(_) => return Ok(dest.to_string_lossy().to_string()),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot save source copy: {e}")),
        }
    }
    Err("too many files with the same source name".to_string())
}

pub fn app_status() -> AppStatus {
    AppStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        library_set: false,
    }
}

#[tauri::command]
fn get_app_status() -> AppStatus {
    app_status()
}

#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {}! Drop a .swf, .exe or audio file to begin.", name)
}

/// Per-sound entry in an inspection report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundReport {
    pub id: u16,
    pub format: u8,
    pub sample_count: u32,
    pub bytes: usize,
}

/// Human-usable report for a `.swf` file. Errors become user-facing strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwfReport {
    pub version: u8,
    pub sounds: Vec<SoundReport>,
    pub skipped: Vec<SoundReport>,
}

/// Report for a `.exe` projector: embedded SWF location + its sounds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExeReport {
    pub swf_offset: usize,
    pub swf_length: usize,
    pub inner: SwfReport,
}

/// Max file size accepted through inspection commands (512 MiB).
const MAX_INPUT_LEN: usize = 512 * 1024 * 1024;

fn read_input(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot open file: {e}"))?;
    if meta.len() > MAX_INPUT_LEN as u64 {
        return Err("file exceeds the 512 MiB inspection limit".to_string());
    }
    std::fs::read(path).map_err(|e| format!("cannot read file: {e}"))
}

fn to_report(s: import::swf::SwfSounds) -> SwfReport {
    SwfReport {
        version: s.version,
        sounds: s
            .sounds
            .iter()
            .map(|x| SoundReport {
                id: x.id,
                format: x.format,
                sample_count: x.sample_count,
                bytes: x.frames.len(),
            })
            .collect(),
        skipped: s
            .skipped
            .iter()
            .map(|x| SoundReport {
                id: x.id,
                format: x.format,
                sample_count: 0,
                bytes: 0,
            })
            .collect(),
    }
}

#[tauri::command]
fn inspect_swf(path: String) -> Result<SwfReport, String> {
    let data = read_input(&path)?;
    import::swf::parse(&data)
        .map(to_report)
        .map_err(|e| import::swf::user_message(&e))
}

#[tauri::command]
fn inspect_exe(path: String) -> Result<ExeReport, String> {
    let data = read_input(&path)?;
    let found = import::exe::locate(&data).map_err(|e| import::exe::user_message(&e))?;
    let inner = import::swf::parse(&data[found.offset..found.offset + found.length])
        .map(to_report)
        .map_err(|e| import::swf::user_message(&e))?;
    Ok(ExeReport {
        swf_offset: found.offset,
        swf_length: found.length,
        inner,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(player::spawn())
        .manage(std::sync::Mutex::new(None::<library::Library>))
        .manage(Mutex::new(midi::MidiManager::default()))
        .setup(|app| {
            use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

            let open_files = MenuItem::with_id(
                app,
                "import-files",
                "Import Files…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let open_swf = MenuItem::with_id(app, "open-swf", "Open SWF…", true, None::<&str>)?;
            let open_exe =
                MenuItem::with_id(app, "open-exe", "Open Projector (EXE)…", true, None::<&str>)?;
            let import_audio =
                MenuItem::with_id(app, "import-audio", "Import Audio…", true, None::<&str>)?;
            let choose_library = MenuItem::with_id(
                app,
                "choose-library",
                "Choose Library Folder…",
                true,
                None::<&str>,
            )?;
            let midi_options =
                MenuItem::with_id(app, "midi-options", "MIDI Options…", true, None::<&str>)?;
            let audio_options =
                MenuItem::with_id(app, "audio-options", "Audio Output…", true, None::<&str>)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .items(&[&open_files, &open_swf, &open_exe, &import_audio])
                .separator()
                .item(&choose_library)
                .separator()
                .close_window()
                .build()?;
            let app_menu = SubmenuBuilder::new(app, "oLooper")
                .about(None)
                .separator()
                .item(&audio_options)
                .item(&midi_options)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .fullscreen()
                .build()?;
            let shortcuts = MenuItem::with_id(
                app,
                "show-shortcuts",
                "Keyboard Shortcuts…",
                true,
                None::<&str>,
            )?;
            let help_menu = SubmenuBuilder::new(app, "Help").item(&shortcuts).build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &window_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                let command = event.id().as_ref();
                if matches!(
                    command,
                    "import-files"
                        | "open-swf"
                        | "open-exe"
                        | "import-audio"
                        | "choose-library"
                        | "show-shortcuts"
                        | "audio-options"
                        | "midi-options"
                ) {
                    let _ = app.emit("olooper:menu-command", command);
                }
            });

            // Background import worker: jobs are enqueued by `import_swf` and
            // processed sequentially with their own SQLite connection, so the
            // UI thread never blocks on a multi-minute import.
            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<ImportJob>();
            app.manage(ImportQueue { tx });
            std::thread::Builder::new()
                .name("olooper-import".to_string())
                .spawn(move || import_worker_loop(handle, rx))
                .expect("cannot spawn import thread");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            greet,
            inspect_swf,
            inspect_exe,
            player_load,
            audio_output_devices,
            audio_set_output,
            audio_test_output,
            player_play,
            player_pause,
            player_stop,
            player_set_volume,
            player_set_speed,
            player_set_pitch_lock,
            player_set_loop,
            player_set_loop_snapped,
            player_set_loop_enabled,
            player_status,
            player_waveform_peaks,
            player_seek,
            player_sample_window,
            player_snap_loop_boundary,
            player_auto_loop,
            player_set_diagnostics,
            library_default_root,
            library_init,
            library_restore,
            library_status,
            library_list,
            library_random_track,
            library_tablist_import_counts,
            library_update_cue_loop,
            library_update_bpm,
            library_remove,
            library_set_favorite,
            library_update_metadata,
            library_mark_played,
            library_export_tracks,
            library_rename_looper,
            library_remove_looper,
            library_group_directory,
            library_group_cover,
            library_get_serato_metadata,
            library_set_serato_cue,
            library_sync_serato_metadata,
            midi_list_inputs,
            midi_connected_input,
            midi_connect,
            midi_disconnect,
            import_swf,
            import_exe,
            import_custom,
            import_tablist,
            tablist_search,
            cancel_import,
            waveform_peaks,
            reveal_in_file_manager
        ])
        .run(tauri::generate_context!())
        .expect("error while running oLooper");
}

type Audio<'a> = tauri::State<'a, player::EngineClient>;

#[tauri::command]
fn player_load(path: String, audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.load(path)
}

#[tauri::command]
fn audio_output_devices() -> Result<Vec<player::AudioOutputDevice>, String> {
    player::list_output_devices()
}

#[tauri::command]
fn audio_set_output(
    device_name: Option<String>,
    first_channel: u16,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.set_output(player::OutputSelection {
        device_name,
        first_channel,
    })
}

#[tauri::command]
fn audio_test_output(
    device_name: Option<String>,
    first_channel: u16,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.test_output(player::OutputSelection {
        device_name,
        first_channel,
    })
}

#[tauri::command]
fn player_play(audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.play()
}

#[tauri::command]
fn player_pause(audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.pause()
}

#[tauri::command]
fn player_stop(audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.stop()
}

#[tauri::command]
fn player_set_volume(volume_pct: f32, audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.set_volume(volume_pct)
}

#[tauri::command]
fn player_set_speed(speed_pct: f32, audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.set_speed(speed_pct)
}

#[tauri::command]
fn player_set_pitch_lock(enabled: bool, audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.set_pitch_lock(enabled)
}

#[tauri::command]
fn player_set_loop(
    start_ms: u64,
    end_ms: u64,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.set_loop(start_ms, end_ms)
}

#[tauri::command]
fn player_set_loop_snapped(
    start_ms: u64,
    end_ms: u64,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.set_loop_snapped(start_ms, end_ms)
}

#[tauri::command]
fn player_set_loop_enabled(
    enabled: bool,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.set_loop_enabled(enabled)
}

#[tauri::command]
fn player_status(audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.status()
}

#[tauri::command]
fn player_seek(position_ms: u64, audio: Audio<'_>) -> Result<player::PlayerStatus, String> {
    audio.seek(position_ms)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SampleWindow {
    start_frame: usize,
    end_frame: usize,
    sample_rate: u32,
    channels: u16,
    samples: Vec<i16>,
}

#[tauri::command]
fn player_sample_window(
    center_frame: usize,
    radius_frames: usize,
    max_points: usize,
    audio: Audio<'_>,
) -> Result<SampleWindow, String> {
    audio.sample_window(center_frame, radius_frames, max_points)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SnappedBoundary {
    frame: usize,
    ms: u64,
    discontinuity: f64,
    zero_crossing_found: bool,
}

#[tauri::command]
fn player_snap_loop_boundary(
    boundary: String,
    requested_frame: usize,
    other_boundary_frame: usize,
    audio: Audio<'_>,
) -> Result<SnappedBoundary, String> {
    audio.snap_loop_boundary(&boundary, requested_frame, other_boundary_frame)
}

#[tauri::command]
fn player_auto_loop(
    bpm: Option<f64>,
    audio: Audio<'_>,
) -> Result<crate::autoloop::AutoLoopResult, String> {
    audio.auto_loop(bpm)
}

#[tauri::command]
fn player_set_diagnostics(
    loop_origin: String,
    loop_quality: f64,
    audio: Audio<'_>,
) -> Result<player::PlayerStatus, String> {
    audio.set_diagnostics(loop_origin, loop_quality)
}

type Db<'a> = tauri::State<'a, std::sync::Mutex<Option<library::Library>>>;

fn db<'a>(db: &'a Db<'_>) -> Result<std::sync::MutexGuard<'a, Option<library::Library>>, String> {
    db.lock().map_err(|e| e.to_string())
}

fn require_lib<'a>(
    guard: &'a std::sync::MutexGuard<'a, Option<library::Library>>,
) -> Result<&'a library::Library, String> {
    guard
        .as_ref()
        .ok_or_else(|| "library not initialized".to_string())
}

#[tauri::command]
fn library_default_root() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "cannot determine the user's home directory".to_string())?;
    let root = suggested_library_root(&home);
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
fn library_init(root: String, db: Db<'_>) -> Result<String, String> {
    let lib = library::Library::open(std::path::Path::new(&root))?;
    let canonical = lib.root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical.to_string_lossy().to_string();
    *db.lock().map_err(|e| e.to_string())? = Some(lib);
    Ok(root)
}

#[tauri::command]
fn library_restore(root: Option<String>, db: Db<'_>) -> Result<Option<String>, String> {
    let root = match root {
        Some(root) => Some(root),
        None => take_legacy_library_root()?,
    };
    let Some(root) = root else {
        return Ok(None);
    };
    let path = std::path::Path::new(&root);
    if !path.is_dir() {
        return Ok(None);
    }
    let lib = library::Library::open(path)?;
    let canonical = lib.root.canonicalize().map_err(|e| e.to_string())?;
    *db.lock().map_err(|e| e.to_string())? = Some(lib);
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if !path.exists() {
        return Err("file no longer exists".to_string());
    }
    let mut command = if cfg!(target_os = "macos") {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{}", path.display()));
        command
    } else {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    };
    command
        .spawn()
        .map_err(|e| format!("cannot reveal file: {e}"))?;
    Ok(())
}

#[tauri::command]
fn library_status(db: Db<'_>) -> Result<serde_json::Value, String> {
    let g = self::db(&db)?;
    match require_lib(&g) {
        Ok(lib) => Ok(serde_json::json!({
            "initialized": true,
            "root": lib.root.to_string_lossy(),
            "tracks": lib.list_tracks()?.len(),
        })),
        Err(_) => Ok(serde_json::json!({ "initialized": false })),
    }
}

#[tauri::command]
fn library_list(db: Db<'_>) -> Result<Vec<library::Track>, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.list_tracks()
}

#[tauri::command]
fn library_random_track(
    exclude_id: Option<i64>,
    db: Db<'_>,
) -> Result<Option<library::Track>, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.random_track(exclude_id)
}

#[tauri::command]
fn library_tablist_import_counts(db: Db<'_>) -> Result<Vec<library::TablistImportCount>, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.tablist_import_counts()
}

#[tauri::command]
fn library_update_cue_loop(
    id: i64,
    cue_ms: i64,
    start_ms: i64,
    end_ms: i64,
    enabled: bool,
    db: Db<'_>,
) -> Result<library::Track, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.update_cue_loop(id, cue_ms, start_ms, end_ms, enabled)
}

#[tauri::command]
fn library_update_bpm(
    id: i64,
    bpm: f64,
    confidence: Option<f64>,
    manual: bool,
    db: Db<'_>,
) -> Result<library::Track, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.update_bpm(id, bpm, confidence, manual)
}

#[tauri::command]
fn library_remove(id: i64, db: Db<'_>) -> Result<bool, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.remove_track(id)
}

#[tauri::command]
fn library_set_favorite(id: i64, favorite: bool, db: Db<'_>) -> Result<library::Track, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.set_favorite(id, favorite)
}

#[tauri::command]
fn library_update_metadata(
    id: i64,
    title: String,
    bpm: Option<f64>,
    tags: String,
    database: Db<'_>,
) -> Result<library::Track, String> {
    require_lib(&db(&database)?)?.update_metadata(id, &title, bpm, &tags)
}

#[tauri::command]
fn library_mark_played(id: i64, database: Db<'_>) -> Result<(), String> {
    require_lib(&db(&database)?)?.mark_played(id)
}

#[tauri::command]
fn library_export_tracks(
    ids: Vec<i64>,
    destination: String,
    database: Db<'_>,
) -> Result<usize, String> {
    require_lib(&db(&database)?)?.export_tracks(&ids, std::path::Path::new(&destination))
}

#[tauri::command]
fn library_rename_looper(source_hash: String, name: String, db: Db<'_>) -> Result<(), String> {
    let g = self::db(&db)?;
    require_lib(&g)?.rename_looper(&source_hash, &name)
}

#[tauri::command]
fn library_remove_looper(source_hash: String, db: Db<'_>) -> Result<usize, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.remove_looper(&source_hash)
}

#[tauri::command]
fn library_group_directory(source_hash: String, db: Db<'_>) -> Result<String, String> {
    let g = self::db(&db)?;
    Ok(require_lib(&g)?
        .group_directory(&source_hash)?
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn library_group_cover(source_hash: String, db: Db<'_>) -> Result<Option<String>, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.group_cover_data_url(&source_hash)
}

#[tauri::command]
fn library_get_serato_metadata(
    track_id: i64,
    db: Db<'_>,
) -> Result<library::SeratoMetadata, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.get_serato_metadata(track_id)
}

#[tauri::command]
fn library_set_serato_cue(
    track_id: i64,
    slot: i64,
    position_ms: Option<i64>,
    db: Db<'_>,
) -> Result<library::SeratoMetadata, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.set_serato_cue(track_id, slot, position_ms)
}

#[tauri::command]
fn library_sync_serato_metadata(track_id: i64, db: Db<'_>) -> Result<(), String> {
    let g = self::db(&db)?;
    require_lib(&g)?.sync_serato_metadata(track_id)
}

#[tauri::command]
fn midi_list_inputs() -> Result<Vec<midi::MidiInputInfo>, String> {
    midi::list_inputs()
}

#[tauri::command]
fn midi_connected_input(
    state: tauri::State<'_, Mutex<midi::MidiManager>>,
) -> Result<Option<midi::MidiInputInfo>, String> {
    state
        .lock()
        .map(|manager| manager.connected_input())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn midi_connect(
    input_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<midi::MidiManager>>,
) -> Result<midi::MidiInputInfo, String> {
    state
        .lock()
        .map_err(|error| error.to_string())?
        .connect(&app, &input_id)
}

#[tauri::command]
fn midi_disconnect(state: tauri::State<'_, Mutex<midi::MidiManager>>) -> Result<(), String> {
    state
        .lock()
        .map_err(|error| error.to_string())?
        .disconnect();
    Ok(())
}

#[tauri::command]
fn waveform_peaks(path: String, buckets: usize) -> Result<waveform::WaveformData, String> {
    let data = read_input(&path)?;
    waveform::compute(&data, buckets)
}

#[tauri::command]
fn player_waveform_peaks(
    path: String,
    buckets: usize,
    audio: Audio<'_>,
    db: Db<'_>,
) -> Result<waveform::WaveformData, String> {
    let cache_dir = require_lib(&self::db(&db)?)?
        .root
        .join(".olooper-cache/waveforms");
    audio.waveform_peaks(&path, buckets, &cache_dir)
}

fn looper_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("looper")
        .to_string()
}

#[tauri::command]
fn cancel_import(job_id: String) -> Result<(), String> {
    CANCELLED_IMPORTS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .map_err(|e| e.to_string())?
        .insert(job_id);
    Ok(())
}

/// One import job for the background worker. The worker opens its own
/// `Library` connection on `root`, so the shared `Db` mutex is only held
/// for the instant it takes to enqueue — playback and library browsing stay
/// responsive during multi-minute imports.
enum ImportKind {
    Swf,
    Exe,
    Custom,
    Tablist,
}

struct ImportJob {
    root: std::path::PathBuf,
    kind: ImportKind,
    paths: Vec<String>,
    cover_path: Option<String>,
    job_id: String,
}

struct ImportQueue {
    tx: std::sync::mpsc::Sender<ImportJob>,
}

fn run_swf_job(app: &tauri::AppHandle, job: &ImportJob) {
    run_container_job(app, job, /* exe */ false);
}

fn run_exe_job(app: &tauri::AppHandle, job: &ImportJob) {
    run_container_job(app, job, /* exe */ true);
}

/// Shared SWF/EXE pipeline: copy source → locate+parse → decode+BPM+insert.
/// `paths[0]` is the dropped file. Runs on the worker with its own connection.
fn run_container_job(app: &tauri::AppHandle, job: &ImportJob, exe: bool) {
    let path = job.paths.first().map(String::as_str).unwrap_or("");
    let fail = |error: String| {
        emit_import_progress(app, &job.job_id, "failed", 0, 0, path, true, Some(error));
    };
    if import_cancelled(&job.job_id) {
        fail("import cancelled".to_string());
        return;
    }
    emit_import_progress(app, &job.job_id, "copying source", 0, 0, path, false, None);
    let data = match read_input(path) {
        Ok(data) => data,
        Err(e) => {
            fail(e);
            return;
        }
    };
    let copied_path = match copy_dropped_source(&job.root, path, &data) {
        Ok(path) => path,
        Err(e) => {
            fail(e);
            return;
        }
    };
    emit_import_progress(
        app,
        &job.job_id,
        "analyzing",
        0,
        0,
        &copied_path,
        false,
        None,
    );
    let source_type = if exe { "exe" } else { "swf" };
    // EXE projectors embed the SWF at an offset; plain SWF parses from zero.
    let (sounds, exe_offset, exe_length) = if exe {
        let found = match import::exe::locate(&data) {
            Ok(found) => found,
            Err(e) => {
                fail(import::exe::user_message(&e));
                return;
            }
        };
        match import::swf::parse(&data[found.offset..found.offset + found.length]) {
            Ok(sounds) => (sounds, Some(found.offset as i64), Some(found.length as i64)),
            Err(e) => {
                fail(import::swf::user_message(&e));
                return;
            }
        }
    } else {
        match import::swf::parse(&data) {
            Ok(sounds) => (sounds, None, None),
            Err(e) => {
                fail(import::swf::user_message(&e));
                return;
            }
        }
    };
    // Own connection: the main one already migrated at `library_init`, so
    // this open is a no-op migration plus WAL setup. Never touches `Db`.
    let lib = match library::Library::open(&job.root) {
        Ok(lib) => lib,
        Err(e) => {
            fail(e);
            return;
        }
    };
    let source_hash = library::sha256_hex(&data);
    let report = lib.import_sounds_with_cover_and_progress(
        &looper_name(&copied_path),
        source_type,
        &copied_path,
        &source_hash,
        exe_offset,
        exe_length,
        &sounds.sounds,
        sounds.cover_image.as_deref(),
        |stage, current, total| {
            if import_cancelled(&job.job_id) {
                return Err("import cancelled".to_string());
            }
            emit_import_progress(
                app,
                &job.job_id,
                stage,
                current,
                total,
                &copied_path,
                false,
                None,
            );
            Ok(())
        },
    );
    let imported_tracks = match &report {
        Ok(report) => report.added + report.already_there,
        Err((partial, _)) => partial.added + partial.already_there,
    };
    if imported_tracks > 0 {
        if let Some(cover) = sounds.cover_image.as_deref() {
            if let Err(error) = lib.save_group_cover(&source_hash, cover) {
                eprintln!("[oLooper] SWF cover was not saved: {error}");
            }
        }
    }
    match report {
        Ok(report) => {
            emit_import_done(
                app,
                &job.job_id,
                report.added + report.already_there,
                sounds.sounds.len(),
                &copied_path,
                Some(report),
                None,
            );
        }
        Err((partial, error)) => {
            let processed = partial.added + partial.already_there + partial.failed.len();
            emit_import_done(
                app,
                &job.job_id,
                processed,
                sounds.sounds.len(),
                format!(
                    "{error}: {processed}/{} sounds processed",
                    sounds.sounds.len()
                ),
                Some(partial),
                None,
            );
        }
    }
}

fn import_worker_loop(app: tauri::AppHandle, rx: std::sync::mpsc::Receiver<ImportJob>) {
    for job in rx {
        match job.kind {
            ImportKind::Swf => run_swf_job(&app, &job),
            ImportKind::Exe => run_exe_job(&app, &job),
            ImportKind::Custom => run_custom_job(&app, &job),
            ImportKind::Tablist => run_tablist_job(&app, &job),
        }
        import_unmark_cancelled(&job.job_id);
    }
}

/// Custom audio imports: per-file decode → copy → BPM → row, with progress
/// per file so the modal tracks each entry. The final `done` event carries
/// the per-file reports (same shape as the old synchronous return).
fn run_custom_job(app: &tauri::AppHandle, job: &ImportJob) {
    let total = job.paths.len();
    let fail = |error: String| {
        emit_import_progress(app, &job.job_id, "failed", 0, total, "", true, Some(error));
    };
    if import_cancelled(&job.job_id) {
        fail("import cancelled".to_string());
        return;
    }
    // Own connection: the main one already migrated at `library_init`, so
    // this open is a no-op migration plus WAL setup. Never touches `Db`.
    let lib = match library::Library::open(&job.root) {
        Ok(lib) => lib,
        Err(e) => {
            fail(e);
            return;
        }
    };
    let mut reports = Vec::with_capacity(total);
    for (i, path) in job.paths.iter().enumerate() {
        if import_cancelled(&job.job_id) {
            fail("import cancelled".to_string());
            return;
        }
        emit_import_progress(
            app,
            &job.job_id,
            "importing audio",
            i,
            total,
            path,
            false,
            None,
        );
        let rep = lib.import_one_custom(path);
        reports.push(rep);
        emit_import_progress(
            app,
            &job.job_id,
            "importing audio",
            i + 1,
            total,
            path,
            false,
            None,
        );
    }
    let added = reports.iter().filter(|r| r.added).count();
    emit_import_done(
        app,
        &job.job_id,
        total,
        total,
        format!("{added} of {total} audio file(s) imported"),
        None,
        Some(reports),
    );
}

/// Resolve one public Tablist looper and import its pre-looped audio tracks.
fn run_tablist_job(app: &tauri::AppHandle, job: &ImportJob) {
    let input = job.paths.first().map(String::as_str).unwrap_or("");
    let fail = |error: String| {
        emit_import_progress(app, &job.job_id, "failed", 0, 0, input, true, Some(error));
    };
    if import_cancelled(&job.job_id) {
        fail("import cancelled".to_string());
        return;
    }
    emit_import_progress(
        app,
        &job.job_id,
        "looking up Tablist looper",
        0,
        0,
        input,
        false,
        None,
    );
    let page = match tablist::resolve_page(input, app) {
        Ok(page) => page,
        Err(error) => {
            fail(error);
            return;
        }
    };
    let lib = match library::Library::open(&job.root) {
        Ok(lib) => lib,
        Err(error) => {
            fail(error);
            return;
        }
    };
    let group_hash = library::sha256_hex(page.path.as_bytes());
    let page_referrer = format!("https://tablist.net/{}", page.path);
    let cover_path = job.cover_path.as_deref().or(page.cover_path.as_deref());
    let cover = cover_path.and_then(|path| match tablist::download_cover(path, &page_referrer) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            eprintln!("[oLooper] Tablist cover was not downloaded: {error}");
            None
        }
    });
    let total = page.tracks.len();
    let mut reports = Vec::with_capacity(total);
    for (index, track) in page.tracks.iter().enumerate() {
        if import_cancelled(&job.job_id) {
            fail("import cancelled".to_string());
            return;
        }
        emit_import_progress(
            app,
            &job.job_id,
            "downloading Tablist track",
            index,
            total,
            &track.title,
            false,
            None,
        );
        let bytes = match tablist::download_track(track, &page_referrer) {
            Ok(bytes) => bytes,
            Err(error) => {
                reports.push(library::CustomReport {
                    file: track.title.clone(),
                    added: false,
                    track_id: None,
                    bpm: track.bpm,
                    bpm_confidence: None,
                    error: Some(error),
                });
                continue;
            }
        };
        let report = lib.import_tablist_track(
            &page.title,
            &group_hash,
            input,
            &track.id,
            &track.title,
            &track.extension,
            &bytes,
            track.bpm,
        );
        reports.push(report);
        emit_import_progress(
            app,
            &job.job_id,
            "importing Tablist track",
            index + 1,
            total,
            &track.title,
            false,
            None,
        );
    }
    if reports.iter().any(|report| report.track_id.is_some()) {
        if let Some(cover) = cover.as_deref() {
            if let Err(error) = lib.save_group_cover(&group_hash, cover) {
                eprintln!("[oLooper] Tablist cover was not saved: {error}");
            }
        }
    }
    let added = reports.iter().filter(|report| report.added).count();
    emit_import_done(
        app,
        &job.job_id,
        total,
        total,
        format!("{added} of {total} Tablist track(s) imported"),
        None,
        Some(reports),
    );
}

#[tauri::command]
fn import_swf(
    path: String,
    job_id: String,
    queue: tauri::State<'_, ImportQueue>,
    db: Db<'_>,
) -> Result<String, String> {
    if import_cancelled(&job_id) {
        return Err("import cancelled".to_string());
    }
    // Short lock: clone the root, then release. The worker does the rest.
    let root = require_lib(&self::db(&db)?)?.root.clone();
    queue
        .tx
        .send(ImportJob {
            root,
            kind: ImportKind::Swf,
            paths: vec![path],
            cover_path: None,
            job_id: job_id.clone(),
        })
        .map_err(|e| format!("import worker unavailable: {e}"))?;
    Ok(job_id)
}

#[tauri::command]
fn import_exe(
    path: String,
    job_id: String,
    queue: tauri::State<'_, ImportQueue>,
    db: Db<'_>,
) -> Result<String, String> {
    if import_cancelled(&job_id) {
        return Err("import cancelled".to_string());
    }
    // Short lock: clone the root, then release. The worker does the rest.
    let root = require_lib(&self::db(&db)?)?.root.clone();
    queue
        .tx
        .send(ImportJob {
            root,
            kind: ImportKind::Exe,
            paths: vec![path],
            cover_path: None,
            job_id: job_id.clone(),
        })
        .map_err(|e| format!("import worker unavailable: {e}"))?;
    Ok(job_id)
}

#[tauri::command]
fn import_custom(
    paths: Vec<String>,
    job_id: String,
    queue: tauri::State<'_, ImportQueue>,
    db: Db<'_>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("select at least one audio file".to_string());
    }
    if import_cancelled(&job_id) {
        return Err("import cancelled".to_string());
    }
    // Short lock: clone the root, then release. The worker does the rest.
    let root = require_lib(&self::db(&db)?)?.root.clone();
    queue
        .tx
        .send(ImportJob {
            root,
            kind: ImportKind::Custom,
            paths,
            cover_path: None,
            job_id: job_id.clone(),
        })
        .map_err(|e| format!("import worker unavailable: {e}"))?;
    Ok(job_id)
}

#[tauri::command]
fn import_tablist(
    url: String,
    cover_path: Option<String>,
    job_id: String,
    queue: tauri::State<'_, ImportQueue>,
    db: Db<'_>,
) -> Result<String, String> {
    tablist::parse_looper_url(&url)?;
    if import_cancelled(&job_id) {
        return Err("import cancelled".to_string());
    }
    let root = require_lib(&self::db(&db)?)?.root.clone();
    queue
        .tx
        .send(ImportJob {
            root,
            kind: ImportKind::Tablist,
            paths: vec![url],
            cover_path,
            job_id: job_id.clone(),
        })
        .map_err(|error| format!("import worker unavailable: {error}"))?;
    Ok(job_id)
}

#[tauri::command]
async fn tablist_search(
    query: String,
    offset: usize,
    limit: Option<usize>,
    app: tauri::AppHandle,
) -> Result<tablist::TablistCatalogPage, String> {
    tauri::async_runtime::spawn_blocking(move || match limit {
        Some(limit) => tablist::search_loopers_with_limit(&app, &query, offset, limit),
        None => tablist::search_loopers(&app, &query, offset),
    })
    .await
    .map_err(|error| format!("Tablist search worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_crate_version_and_os() {
        let s = app_status();
        assert_eq!(s.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(s.platform, std::env::consts::OS);
        assert!(!s.library_set);
    }

    #[test]
    fn status_roundtrips_through_json() {
        let s = app_status();
        let v: AppStatus = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(s, v);
    }

    #[test]
    fn greet_names_user_without_echoing_raw_input_twice() {
        let out = greet("DJ".to_string());
        assert!(out.contains("DJ"));
    }

    #[test]
    fn portable_root_uses_parent_of_macos_app_bundle() {
        let executable = std::path::Path::new("/Applications/oLooper.app/Contents/MacOS/oLooper");
        assert_eq!(
            portable_root_for_executable(executable).unwrap(),
            std::path::PathBuf::from("/Applications"),
        );
    }

    #[test]
    fn portable_root_uses_executable_parent_outside_app_bundle() {
        let executable = std::path::Path::new("/tmp/olooper/olooper");
        assert_eq!(
            portable_root_for_executable(executable).unwrap(),
            std::path::PathBuf::from("/tmp/olooper"),
        );
    }

    #[test]
    fn first_run_library_suggestion_uses_documents_folder() {
        assert_eq!(
            suggested_library_root(std::path::Path::new("/Users/dj")),
            std::path::PathBuf::from("/Users/dj/Documents/oLooper_data"),
        );
    }

    #[test]
    fn legacy_app_side_library_selection_is_migrated_and_removed() {
        let dir = std::env::temp_dir().join(format!(
            "olooper-legacy-selection-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let selection = dir.join("olooper-library.json");
        std::fs::write(
            &selection,
            serde_json::to_vec(&SavedLibraryRoot {
                root: "/Users/dj/Documents/oLooper_data".to_string(),
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            take_legacy_library_root_from(&selection).unwrap(),
            Some("/Users/dj/Documents/oLooper_data".to_string()),
        );
        assert!(!selection.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn source_copy_preserves_bytes_deduplicates_and_avoids_collisions() {
        let root = std::env::temp_dir().join(format!(
            "olooper-source-copy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let library_root = root.join("selected-library");
        let source_root = library_root.join("loopersFlash");
        let first = copy_dropped_source(&library_root, "/drop/My Looper.swf", b"first").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        assert!(std::path::Path::new(&first).starts_with(&library_root));

        let repeated = copy_dropped_source(&library_root, "/drop/My Looper.swf", b"first").unwrap();
        assert_eq!(repeated, first);

        let collision =
            copy_dropped_source(&library_root, "/drop/My Looper.swf", b"second").unwrap();
        assert_ne!(collision, first);
        assert!(collision.ends_with("My Looper (2).swf"));
        assert_eq!(std::fs::read(collision).unwrap(), b"second");
        assert!(source_root.is_dir());

        #[cfg(unix)]
        {
            let sentinel = root.join("outside-source");
            std::fs::write(&sentinel, b"untouched").unwrap();
            std::os::unix::fs::symlink(&sentinel, source_root.join("Another.exe.tmp")).unwrap();
            let copied =
                copy_dropped_source(&library_root, "/drop/Another.exe", b"projector").unwrap();
            assert_eq!(std::fs::read(copied).unwrap(), b"projector");
            assert_eq!(std::fs::read(sentinel).unwrap(), b"untouched");
        }

        std::fs::remove_dir_all(root).unwrap();
    }
}
