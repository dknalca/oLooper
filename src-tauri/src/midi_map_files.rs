use std::io::{Read, Write};
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

const MAX_MAP_BYTES: usize = 64 * 1024;

fn read_map(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut contents = String::new();
    file.take((MAX_MAP_BYTES + 1) as u64)
        .read_to_string(&mut contents)
        .map_err(|error| error.to_string())?;
    validate_json(&contents)?;
    Ok(contents)
}

fn validate_json(contents: &str) -> Result<(), String> {
    if contents.len() > MAX_MAP_BYTES {
        return Err("MIDI map exceeds 64 KiB.".into());
    }
    serde_json::from_str::<serde_json::Value>(contents)
        .map_err(|error| format!("Invalid MIDI map JSON: {error}"))?;
    Ok(())
}

fn write_map(path: &Path, contents: &str) -> Result<(), String> {
    validate_json(contents)?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return Err("MIDI map files must use the .json extension.".into());
    }
    let parent = path.parent().ok_or("Invalid MIDI map destination.")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temporary
        .write_all(contents.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn midi_import_map_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("MIDI map", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|error| error.to_string())?;
        read_map(&path).map(Some)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn midi_export_map_file(
    app: tauri::AppHandle,
    filename: String,
    contents: String,
) -> Result<bool, String> {
    validate_json(&contents)?;
    // The suggested name is never a path; the native dialog owns the destination.
    let filename: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.') {
                character
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("MIDI map", &["json"])
            .set_file_name(&filename)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut path = file.into_path().map_err(|error| error.to_string())?;
        if path.extension().is_none() {
            path.set_extension("json");
        }
        write_map(&path, &contents)?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_map_files_roundtrip_and_replace_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.json");
        write_map(&path, "{}").unwrap();
        write_map(&path, "{\"version\":1}").unwrap();
        assert_eq!(read_map(&path).unwrap(), "{\"version\":1}");
        assert!(write_map(&path, "invalid").is_err());
        assert_eq!(read_map(&path).unwrap(), "{\"version\":1}");
        assert!(write_map(&directory.path().join("test.exe"), "{}").is_err());
    }

    #[test]
    fn midi_map_files_reject_oversized_or_invalid_input() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.json");
        std::fs::write(&path, " ".repeat(MAX_MAP_BYTES + 1)).unwrap();
        assert!(read_map(&path).unwrap_err().contains("64 KiB"));
        std::fs::write(&path, b"not JSON").unwrap();
        assert!(read_map(&path).is_err());
        assert!(write_map(&path, &" ".repeat(MAX_MAP_BYTES + 1)).is_err());
    }
}
