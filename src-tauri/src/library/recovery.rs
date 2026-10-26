use super::{Library, QuarantinedFiles};
use std::io::{Read, Write};

impl Library {
    #[cfg(any(target_os = "windows", test))]
    pub(super) fn recover_metadata_files(&self) -> Result<(), String> {
        for track in self.query_tracks(None, None)? {
            if track.audio_storage == "extracted" && !track.exists {
                let path = self.confine(std::path::Path::new(&track.file_path))?;
                super::serato::recover_replacement(&path)?;
            }
        }
        Ok(())
    }

    pub(super) fn write_quarantine_manifest(&self, files: &QuarantinedFiles) -> Result<(), String> {
        let data = serde_json::to_vec(files).map_err(|e| e.to_string())?;
        if data.len() > 16 * 1024 * 1024 {
            return Err("recovery manifest exceeds 16 MiB; remove a smaller batch".into());
        }
        let mut temporary =
            tempfile::NamedTempFile::new_in(&files.directory).map_err(|e| e.to_string())?;
        temporary
            .write_all(&data)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        temporary
            .persist_noclobber(files.directory.join("manifest.json"))
            .map_err(|e| e.to_string())?;
        sync_directory(&files.directory)?;
        sync_directory(
            files
                .directory
                .parent()
                .ok_or("invalid quarantine directory")?,
        )
    }

    pub(super) fn recover_quarantined(&self) -> Result<(), String> {
        let root = self.root.canonicalize().map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".olooper-trash-")
                || !entry.file_type().map_err(|e| e.to_string())?.is_dir()
            {
                continue;
            }
            let directory = entry.path();
            let manifest_path = directory.join("manifest.json");
            if !manifest_path.exists() {
                continue;
            } // Legacy quarantine: never guess ownership.
            let mut data = Vec::new();
            std::fs::File::open(&manifest_path)
                .and_then(|file| file.take(16 * 1024 * 1024 + 1).read_to_end(&mut data))
                .map_err(|e| format!("cannot read recovery manifest: {e}"))?;
            if data.len() > 16 * 1024 * 1024 {
                return Err("recovery manifest exceeds 16 MiB".into());
            }
            let files: QuarantinedFiles = serde_json::from_slice(&data)
                .map_err(|e| format!("invalid recovery manifest: {e}"))?;
            let mut restore = false;
            for (index, (original, staged)) in files.moved.iter().enumerate() {
                let parent = original
                    .parent()
                    .ok_or("invalid recovery path")?
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !parent.starts_with(&root)
                    || original.file_name().is_none()
                    || staged != &directory.join(format!("asset-{index}"))
                {
                    return Err("recovery path escapes library or quarantine".into());
                }
                let references: i64 = self
                    .conn
                    .query_row(
                        "SELECT COUNT(*) FROM tracks WHERE file_path=?1 OR source_path=?1",
                        [original.to_string_lossy().as_ref()],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                restore |= references > 0;
            }
            if restore {
                for (original, staged) in &files.moved {
                    if !staged.exists() {
                        continue;
                    }
                    if !std::fs::symlink_metadata(staged)
                        .map_err(|e| e.to_string())?
                        .is_file()
                    {
                        return Err("recovery asset is not a regular file".into());
                    }
                    if original.exists() {
                        return Err(format!(
                            "recovery would overwrite {}; staged audio retained",
                            original.display()
                        ));
                    }
                    std::fs::rename(staged, original).map_err(|e| e.to_string())?;
                    sync_directory(original.parent().ok_or("invalid recovery path")?)?;
                }
            }
            // Use the validated directory, never the directory field from JSON.
            std::fs::remove_dir_all(&directory).map_err(|e| e.to_string())?;
            sync_directory(&root)?;
        }
        Ok(())
    }
}

pub(super) fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
