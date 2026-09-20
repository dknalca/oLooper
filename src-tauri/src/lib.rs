use serde::{Deserialize, Serialize};
use tauri::Emitter as _;
use std::sync::{Mutex, OnceLock};

static CANCELLED_IMPORTS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

fn import_cancelled(job_id: &str) -> bool {
    CANCELLED_IMPORTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock().map(|jobs| jobs.contains(job_id)).unwrap_or(false)
}

pub mod analysis;
pub mod import;
pub mod library;
pub mod player;
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

fn portable_library_root() -> Result<std::path::PathBuf, String> {
    Ok(portable_root()?.join("library"))
}

fn portable_sources_root() -> Result<std::path::PathBuf, String> {
    Ok(portable_root()?.join("loopersFlash"))
}

fn library_selection_path() -> Result<std::path::PathBuf, String> {
    Ok(portable_root()?.join("olooper-library.json"))
}

fn save_library_root(root: &str) -> Result<(), String> {
    let path = library_selection_path()?;
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec(&SavedLibraryRoot {
        root: root.to_string(),
    })
    .map_err(|e| format!("cannot serialize library selection: {e}"))?;
    std::fs::write(&tmp, data).map_err(|e| format!("cannot save library selection: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot save library selection: {e}"));
    }
    Ok(())
}

fn saved_library_root() -> Result<Option<String>, String> {
    let path = library_selection_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&path).map_err(|e| format!("cannot read library selection: {e}"))?;
    let saved: SavedLibraryRoot =
        serde_json::from_slice(&data).map_err(|e| format!("cannot read library selection: {e}"))?;
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
        },
    );
}

fn copy_dropped_source(path: &str, data: &[u8]) -> Result<String, String> {
    let source_dir = portable_sources_root()?;
    std::fs::create_dir_all(&source_dir).map_err(|e| {
        format!("cannot create loopersFlash beside the app; move the app to a writable folder: {e}")
    })?;
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
        let tmp = dest.with_extension(format!("{ext}.tmp"));
        std::fs::write(&tmp, data).map_err(|e| format!("cannot copy source: {e}"))?;
        let verified =
            std::fs::read(&tmp).map_err(|e| format!("cannot verify source copy: {e}"))?;
        if verified != data {
            let _ = std::fs::remove_file(&tmp);
            return Err("cannot verify source copy".to_string());
        }
        if let Err(e) = std::fs::rename(&tmp, &dest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("cannot save source copy: {e}"));
        }
        return Ok(dest.to_string_lossy().to_string());
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
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            greet,
            inspect_swf,
            inspect_exe,
            player_load,
            player_play,
            player_pause,
            player_stop,
            player_set_volume,
            player_set_speed,
            player_set_pitch_lock,
            player_set_loop,
            player_set_loop_enabled,
            player_status,
            player_waveform_peaks,
            player_seek,
            library_default_root,
            library_init,
            library_portable_init,
            library_restore,
            library_status,
            library_list,
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
            library_get_slots,
            library_set_slot,
            library_delete_slot,
            import_swf,
            import_exe,
            import_custom,
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

fn init_portable_library(db: &Db<'_>) -> Result<String, String> {
    let root = portable_library_root()?;
    let lib = library::Library::open(&root).map_err(|e| {
        format!("cannot open library beside the app; move the app to a writable folder: {e}")
    })?;
    let canonical = lib.root.canonicalize().map_err(|e| e.to_string())?;
    *db.lock().map_err(|e| e.to_string())? = Some(lib);
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
fn library_default_root() -> Result<String, String> {
    Ok(portable_library_root()?.to_string_lossy().to_string())
}

#[tauri::command]
fn library_init(root: String, db: Db<'_>) -> Result<String, String> {
    let lib = library::Library::open(std::path::Path::new(&root))?;
    let canonical = lib.root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical.to_string_lossy().to_string();
    save_library_root(&root)?;
    *db.lock().map_err(|e| e.to_string())? = Some(lib);
    Ok(root)
}

#[tauri::command]
fn library_restore(db: Db<'_>) -> Result<Option<String>, String> {
    let Some(root) = saved_library_root()? else {
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
fn library_portable_init(db: Db<'_>) -> Result<String, String> {
    init_portable_library(&db)
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
fn library_update_metadata(id: i64, title: String, bpm: Option<f64>, tags: String, database: Db<'_>) -> Result<library::Track, String> {
    require_lib(&db(&database)? )?.update_metadata(id, &title, bpm, &tags)
}

#[tauri::command]
fn library_mark_played(id: i64, database: Db<'_>) -> Result<(), String> {
    require_lib(&db(&database)? )?.mark_played(id)
}

#[tauri::command]
fn library_export_tracks(ids: Vec<i64>, destination: String, database: Db<'_>) -> Result<usize, String> {
    require_lib(&db(&database)? )?.export_tracks(&ids, std::path::Path::new(&destination))
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
fn library_get_slots(track_id: i64, db: Db<'_>) -> Result<Vec<library::LoopSlot>, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.get_slots(track_id)
}

#[tauri::command]
fn library_set_slot(
    track_id: i64,
    slot: i64,
    label: String,
    cue_ms: i64,
    loop_start_ms: i64,
    loop_end_ms: i64,
    enabled: bool,
    db: Db<'_>,
) -> Result<library::LoopSlot, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.set_slot(
        track_id,
        slot,
        &label,
        cue_ms,
        loop_start_ms,
        loop_end_ms,
        enabled,
    )
}

#[tauri::command]
fn library_delete_slot(track_id: i64, slot: i64, db: Db<'_>) -> Result<bool, String> {
    let g = self::db(&db)?;
    require_lib(&g)?.delete_slot(track_id, slot)
}

#[tauri::command]
fn import_custom(paths: Vec<String>, db: Db<'_>) -> Result<Vec<library::CustomReport>, String> {
    let g = self::db(&db)?;
    Ok(require_lib(&g)?.import_custom(&paths))
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
    CANCELLED_IMPORTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock().map_err(|e| e.to_string())?.insert(job_id);
    Ok(())
}

#[tauri::command]
fn import_swf(
    path: String,
    job_id: String,
    app: tauri::AppHandle,
    db: Db<'_>,
) -> Result<library::ImportReport, String> {
    if import_cancelled(&job_id) { return Err("import cancelled".to_string()); }
    emit_import_progress(&app, &job_id, "copying source", 0, 0, &path, false, None);
    let data = read_input(&path)?;
    let copied_path = copy_dropped_source(&path, &data)?;
    emit_import_progress(&app, &job_id, "analyzing", 0, 0, &copied_path, false, None);
    let sounds = match import::swf::parse(&data) {
        Ok(sounds) => sounds,
        Err(e) => {
            let error = import::swf::user_message(&e);
            emit_import_progress(
                &app,
                &job_id,
                "failed",
                0,
                0,
                &copied_path,
                true,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    let g = self::db(&db)?;
    let lib = require_lib(&g)?;
    let report = lib.import_sounds_with_progress(
        &looper_name(&copied_path),
        "swf",
        &copied_path,
        &library::sha256_hex(&data),
        None,
        None,
        &sounds.sounds,
        |stage, current, total| {
            if import_cancelled(&job_id) { return Err("import cancelled".to_string()); }
            emit_import_progress(
                &app,
                &job_id,
                stage,
                current,
                total,
                &copied_path,
                false,
                None,
            ); Ok(())
        },
    );
    match report {
        Ok(report) => {
            emit_import_progress(
                &app,
                &job_id,
                "complete",
                report.added + report.already_there,
                sounds.sounds.len(),
                &copied_path,
                true,
                None,
            );
            Ok(report)
        }
        Err(error) => {
            emit_import_progress(
                &app,
                &job_id,
                "failed",
                0,
                sounds.sounds.len(),
                &copied_path,
                true,
                Some(error.clone()),
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn import_exe(
    path: String,
    job_id: String,
    app: tauri::AppHandle,
    db: Db<'_>,
) -> Result<library::ImportReport, String> {
    if import_cancelled(&job_id) { return Err("import cancelled".to_string()); }
    emit_import_progress(&app, &job_id, "copying source", 0, 0, &path, false, None);
    let data = read_input(&path)?;
    let copied_path = copy_dropped_source(&path, &data)?;
    emit_import_progress(&app, &job_id, "analyzing", 0, 0, &copied_path, false, None);
    let found = match import::exe::locate(&data) {
        Ok(found) => found,
        Err(e) => {
            let error = import::exe::user_message(&e);
            emit_import_progress(
                &app,
                &job_id,
                "failed",
                0,
                0,
                &copied_path,
                true,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    let sounds = match import::swf::parse(&data[found.offset..found.offset + found.length]) {
        Ok(sounds) => sounds,
        Err(e) => {
            let error = import::swf::user_message(&e);
            emit_import_progress(
                &app,
                &job_id,
                "failed",
                0,
                0,
                &copied_path,
                true,
                Some(error.clone()),
            );
            return Err(error);
        }
    };
    let g = self::db(&db)?;
    let lib = require_lib(&g)?;
    let report = lib.import_sounds_with_progress(
        &looper_name(&copied_path),
        "exe",
        &copied_path,
        &library::sha256_hex(&data),
        Some(found.offset as i64),
        Some(found.length as i64),
        &sounds.sounds,
        |stage, current, total| {
            if import_cancelled(&job_id) { return Err("import cancelled".to_string()); }
            emit_import_progress(
                &app,
                &job_id,
                stage,
                current,
                total,
                &copied_path,
                false,
                None,
            ); Ok(())
        },
    );
    match report {
        Ok(report) => {
            emit_import_progress(
                &app,
                &job_id,
                "complete",
                report.added + report.already_there,
                sounds.sounds.len(),
                &copied_path,
                true,
                None,
            );
            Ok(report)
        }
        Err(error) => {
            emit_import_progress(
                &app,
                &job_id,
                "failed",
                0,
                sounds.sounds.len(),
                &copied_path,
                true,
                Some(error.clone()),
            );
            Err(error)
        }
    }
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
    fn source_copy_preserves_bytes_deduplicates_and_avoids_collisions() {
        let root = std::env::temp_dir().join(format!(
            "olooper-source-copy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let first = copy_dropped_source_to(&root, "/drop/My Looper.swf", b"first").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first");

        let repeated = copy_dropped_source_to(&root, "/drop/My Looper.swf", b"first").unwrap();
        assert_eq!(repeated, first);

        let collision = copy_dropped_source_to(&root, "/drop/My Looper.swf", b"second").unwrap();
        assert_ne!(collision, first);
        assert!(collision.ends_with("My Looper (2).swf"));
        assert_eq!(std::fs::read(collision).unwrap(), b"second");

        std::fs::remove_dir_all(root).unwrap();
    }
}
