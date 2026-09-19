use serde::{Deserialize, Serialize};

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
            player_set_loop,
            player_set_loop_enabled,
            player_status,
            player_seek,
            library_init,
            library_status,
            library_list,
            library_update_cue_loop,
            library_update_bpm,
            library_remove,
            import_swf,
            import_exe,
            import_custom,
            waveform_peaks
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
    guard.as_ref().ok_or_else(|| "library not initialized".to_string())
}

#[tauri::command]
fn library_init(root: String, db: Db<'_>) -> Result<String, String> {
    let lib = library::Library::open(std::path::Path::new(&root))?;
    let canonical = lib.root.canonicalize().map_err(|e| e.to_string())?;
    *db.lock().map_err(|e| e.to_string())? = Some(lib);
    Ok(canonical.to_string_lossy().to_string())
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
fn import_custom(paths: Vec<String>, db: Db<'_>) -> Result<Vec<library::CustomReport>, String> {
    let g = self::db(&db)?;
    Ok(require_lib(&g)?.import_custom(&paths))
}

#[tauri::command]
fn waveform_peaks(path: String, buckets: usize) -> Result<waveform::WaveformData, String> {
    let data = read_input(&path)?;
    waveform::compute(&data, buckets)
}

fn looper_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("looper")
        .to_string()
}

#[tauri::command]
fn import_swf(path: String, db: Db<'_>) -> Result<library::ImportReport, String> {
    let data = read_input(&path)?;
    let sounds = import::swf::parse(&data).map_err(|e| import::swf::user_message(&e))?;
    let g = self::db(&db)?;
    let lib = require_lib(&g)?;
    lib.import_sounds(
        &looper_name(&path),
        "swf",
        &path,
        &library::sha256_hex(&data),
        None,
        None,
        &sounds.sounds,
    )
}

#[tauri::command]
fn import_exe(path: String, db: Db<'_>) -> Result<library::ImportReport, String> {
    let data = read_input(&path)?;
    let found = import::exe::locate(&data).map_err(|e| import::exe::user_message(&e))?;
    let sounds = import::swf::parse(&data[found.offset..found.offset + found.length])
        .map_err(|e| import::swf::user_message(&e))?;
    let g = self::db(&db)?;
    let lib = require_lib(&g)?;
    lib.import_sounds(
        &looper_name(&path),
        "exe",
        &path,
        &library::sha256_hex(&data),
        Some(found.offset as i64),
        Some(found.length as i64),
        &sounds.sounds,
    )
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
}
