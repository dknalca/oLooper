//! Persistent source folders. Reconciliation removes catalog rows only: it must
//! never delete surviving extracted audio, source copies, or external inputs.
use super::*;
use std::collections::HashMap;
use std::io::Read;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkedFolder {
    pub id: i64,
    pub path: String,
    pub extract_audio: bool,
    pub copy_source: bool,
    pub library_root: String,
}

#[derive(Debug, Serialize)]
pub struct FolderScan {
    pub folder: LinkedFolder,
    pub paths: Vec<String>,
    pub removed: usize,
    pub unchanged: usize,
}

fn device_id(path: &Path) -> Result<Option<String>, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("Folder unavailable: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(metadata.dev().to_string()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Ok(None)
    }
}

#[derive(PartialEq, Eq)]
struct SourceIdentity {
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn source_identity(metadata: &std::fs::Metadata) -> SourceIdentity {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    SourceIdentity {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    }
}

fn path_identity(path: &Path) -> Result<SourceIdentity, String> {
    let kind = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !kind.is_file() {
        return Err("Source changed during scan; retry the scan".into());
    }
    Ok(source_identity(&kind))
}

fn file_hash(path: &Path) -> Result<(String, SourceIdentity), String> {
    let before = path_identity(path)?;
    let mut file = crate::bounded_io::open_regular(path).map_err(|e| e.to_string())?;
    if source_identity(&file.metadata().map_err(|e| e.to_string())?) != before {
        return Err("Source changed during scan; retry the scan".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    let mut total = 0u64;
    loop {
        crate::check_cancelled()?;
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > 512 * 1024 * 1024 {
            return Err("Source exceeds the 512 MiB limit".into());
        }
        hash.update(&buffer[..count]);
    }
    if source_identity(&file.metadata().map_err(|e| e.to_string())?) != before
        || path_identity(path)? != before
    {
        return Err("Source changed during scan; retry the scan".into());
    }
    Ok((digest_hex(&hash.finalize()), before))
}

// Missing parents may mean a disconnected volume. Never prune in that case.
fn audio_missing(path: &Path, library: &Path, source: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(!metadata.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut parent = path.parent().ok_or("Audio has no parent folder")?;
            let canonical_library = library
                .canonicalize()
                .map_err(|e| format!("Library unavailable: {e}"))?;
            let anchor = if path.starts_with(library) {
                library
            } else if path.starts_with(&canonical_library) {
                &canonical_library
            } else {
                source
            };
            // A deleted looper subdirectory is different from a missing volume.
            while parent.starts_with(anchor) && parent != anchor {
                match std::fs::metadata(parent) {
                    Ok(_) => break,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        parent = parent.parent().ok_or("Audio folder unavailable")?;
                    }
                    Err(e) => {
                        return Err(format!("Audio folder unavailable (nothing removed): {e}"))
                    }
                }
            }
            std::fs::read_dir(parent)
                .map_err(|e| format!("Audio folder unavailable (nothing removed): {e}"))?;
            Ok(true)
        }
        Err(error) => Err(format!("Cannot inspect audio (nothing removed): {error}")),
    }
}

impl Library {
    pub fn linked_folders(&self) -> Result<Vec<LinkedFolder>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT id,path,extract_audio,copy_source FROM linked_folders ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok(LinkedFolder {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    extract_audio: r.get(2)?,
                    copy_source: r.get(3)?,
                    library_root: self.root.to_string_lossy().into_owned(),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn link_folder(
        &self,
        path: &Path,
        extract: bool,
        copy: bool,
    ) -> Result<LinkedFolder, String> {
        // Complete enumeration first, including empty folders and nested access errors.
        crate::import_folder::scan(path)?;
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        let path = path.to_str().ok_or("Folder path is not valid Unicode")?;
        let _guard = self.operations.lock.lock();
        self.conn.execute("INSERT INTO linked_folders(path,extract_audio,copy_source,device_id) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET extract_audio=excluded.extract_audio,copy_source=excluded.copy_source,device_id=excluded.device_id", rusqlite::params![path, extract, copy, device_id(Path::new(path))?]).map_err(|e| e.to_string())?;
        // Adopt previously imported original sources when linking an existing folder.
        for track in self.list_tracks()? {
            if matches!(track.source_type.as_str(), "swf" | "exe")
                && Path::new(&track.source_path).starts_with(path)
            {
                self.record_folder_source(&track.source_path, &track.source_hash, false)?;
            }
        }
        self.linked_folders()?
            .into_iter()
            .find(|f| f.path == path)
            .ok_or("Linked folder vanished".into())
    }

    pub(crate) fn record_folder_source(
        &self,
        original: &str,
        hash: &str,
        complete: bool,
    ) -> Result<(), String> {
        let _guard = self.operations.lock.lock();
        let folders = self.linked_folders()?;
        // A source may belong to nested linked folders. Either record all of
        // those associations or none; a later rescan relies on their consistency.
        let transaction = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for folder in folders {
            if Path::new(original).starts_with(&folder.path) {
                transaction.execute("INSERT INTO linked_folder_sources(folder_id,source_hash,complete) VALUES(?1,?2,?3) ON CONFLICT(folder_id,source_hash) DO UPDATE SET complete=MAX(complete,excluded.complete)", rusqlite::params![folder.id, hash, complete]).map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn folders_for_source(&self, hash: &str) -> Result<Vec<LinkedFolder>, String> {
        let folders = self.linked_folders()?;
        folders
            .into_iter()
            .filter_map(|folder| {
                match self
                    .conn
                    .query_row(
                        "SELECT 1 FROM linked_folder_sources WHERE folder_id=?1 AND source_hash=?2",
                        rusqlite::params![folder.id, hash],
                        |_| Ok(()),
                    )
                    .optional()
                {
                    Ok(Some(())) => Some(Ok(folder)),
                    Ok(None) => None,
                    Err(e) => Some(Err(e.to_string())),
                }
            })
            .collect()
    }

    pub fn rescan_folder(&self, id: i64) -> Result<FolderScan, String> {
        self.rescan_folder_with_scan(id, crate::import_folder::scan)
    }

    fn rescan_folder_with_scan(
        &self,
        id: i64,
        mut scan: impl FnMut(&Path) -> Result<Vec<String>, String>,
    ) -> Result<FolderScan, String> {
        let folder = self
            .linked_folders()?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or("Linked folder not found")?;
        let expected_device: Option<String> = self
            .conn
            .query_row(
                "SELECT device_id FROM linked_folders WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let verify_device = || -> Result<(), String> {
            if device_id(Path::new(&folder.path))? != expected_device {
                return Err("Source volume changed or was disconnected; nothing removed. Reconnect it or import the folder again.".into());
            }
            Ok(())
        };
        verify_device()?;
        let files = scan(Path::new(&folder.path))?;
        // Hash with bounded scratch, without holding the library mutation lock.
        let mut hashes = HashMap::new();
        let mut identities = HashMap::new();
        for path in &files {
            let (hash, identity) = file_hash(Path::new(path))?;
            hashes.insert(path.clone(), hash);
            identities.insert(path.clone(), identity);
        }
        let _guard = self.operations.lock.lock();
        let mut statement = self
            .conn
            .prepare("SELECT source_hash,complete FROM linked_folder_sources WHERE folder_id=?1")
            .map_err(|e| e.to_string())?;
        let known = statement
            .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        let tracks: Vec<_> = self
            .list_tracks()?
            .into_iter()
            .filter(|t| known.contains_key(&t.source_hash))
            .collect();
        let mut missing = Vec::new();
        let mut relocated = Vec::new();
        // Validate every dependency before starting a transaction. Any inaccessible
        // parent aborts the entire reconciliation, not just that track.
        for track in &tracks {
            let changed = track.audio_storage == "embedded"
                && hashes
                    .get(&track.file_path)
                    .is_some_and(|hash| hash != &track.source_hash);
            if audio_missing(
                Path::new(&track.file_path),
                &self.root,
                Path::new(&folder.path),
            )? || changed
            {
                if track.audio_storage == "embedded" && !track.source_managed {
                    if let Some(path) = files.iter().find(|path| hashes[*path] == track.source_hash)
                    {
                        relocated.push((track.id, path.clone()));
                        continue;
                    }
                }
                missing.push(track.id);
            }
        }
        // A successful second traversal alone is not enough: a different set of
        // sources would make the hashes and deletion decisions stale.
        if scan(Path::new(&folder.path))? != files {
            return Err(
                "Source folder changed during scan; nothing removed. Retry the scan.".into(),
            );
        }
        for path in &files {
            if path_identity(Path::new(path)).ok().as_ref() != identities.get(path) {
                return Err("Source changed during scan; nothing removed. Retry the scan.".into());
            }
        }
        verify_device()?;
        let transaction = self
            .conn
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        for (id, path) in relocated {
            transaction
                .execute(
                    "UPDATE tracks SET file_path=?1,source_path=?1 WHERE id=?2",
                    rusqlite::params![path, id],
                )
                .map_err(|e| e.to_string())?;
        }
        for id in &missing {
            transaction
                .execute("DELETE FROM tracks WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
        transaction.execute("DELETE FROM looper_order WHERE NOT EXISTS(SELECT 1 FROM tracks WHERE tracks.source_hash=looper_order.source_hash)", []).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        let paths: Vec<_> = files
            .into_iter()
            .filter(|path| {
                let hash = &hashes[path];
                // Remember successful imports even if all audio entries were
                // removed. Do not recreate an unchanged looper's deleted audio.
                known.get(hash) != Some(&true)
            })
            .collect();
        Ok(FolderScan {
            folder,
            unchanged: hashes.len() - paths.len(),
            paths,
            removed: missing.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(root: &Path, name: &str, bytes: &[u8]) -> String {
        let path = root.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_str().unwrap().into()
    }

    #[test]
    fn source_association_rolls_back_all_nested_folders_on_failure() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let parent = sources.path().canonicalize().unwrap();
        let nested = parent.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let original = source(&nested, "one.swf", b"source");
        let lib = Library::open(library.path()).unwrap();
        let outer = lib.link_folder(&parent, false, false).unwrap();
        let inner = lib.link_folder(&nested, false, false).unwrap();
        lib.conn.execute_batch(&format!(
            "CREATE TRIGGER reject_nested_association BEFORE INSERT ON linked_folder_sources WHEN NEW.folder_id = {} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
            inner.id,
        )).unwrap();

        assert!(lib.record_folder_source(&original, "hash", true).is_err());
        assert!(lib.folders_for_source("hash").unwrap().is_empty());
        lib.conn
            .execute_batch("DROP TRIGGER reject_nested_association")
            .unwrap();
        lib.record_folder_source(&original, "hash", true).unwrap();
        let folders = lib.folders_for_source("hash").unwrap();
        assert_eq!(
            folders.iter().map(|folder| folder.id).collect::<Vec<_>>(),
            vec![outer.id, inner.id]
        );
    }

    #[test]
    fn rescan_aborts_before_pruning_if_source_listing_changes() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&sources, "old.swf", b"original");
        let hash = sha256_hex(b"original");
        let folder = lib.link_folder(&sources, false, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "track", &hash);
        lib.conn.execute(
            "UPDATE tracks SET audio_storage='embedded',file_path=?1,source_path=?1,source_managed=0 WHERE id=?2",
            rusqlite::params![original, id],
        ).unwrap();
        lib.record_folder_source(&original, &hash, true).unwrap();
        std::fs::remove_file(&original).unwrap();

        let mut calls = 0;
        let result = lib.rescan_folder_with_scan(folder.id, |root| {
            calls += 1;
            if calls == 2 {
                std::fs::write(root.join("moved.swf"), b"original").unwrap();
            }
            crate::import_folder::scan(root)
        });
        assert!(result.unwrap_err().contains("nothing removed"));
        assert_eq!(calls, 2);
        assert!(lib.get_track(id).unwrap().is_some());
        assert!(sources.join("moved.swf").is_file());
        // A stable retry can relocate the track without changing its identity.
        assert_eq!(lib.rescan_folder(folder.id).unwrap().removed, 0);
        assert!(lib
            .get_track(id)
            .unwrap()
            .unwrap()
            .file_path
            .ends_with("moved.swf"));
    }

    #[test]
    fn rescan_aborts_if_source_content_changes_without_a_new_filename() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&sources, "source.swf", b"original");
        let hash = sha256_hex(b"original");
        let folder = lib.link_folder(&sources, false, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "track", &hash);
        lib.conn.execute(
            "UPDATE tracks SET audio_storage='embedded',file_path=?1,source_path=?1,source_managed=0 WHERE id=?2",
            rusqlite::params![original, id],
        ).unwrap();
        lib.record_folder_source(&original, &hash, true).unwrap();
        std::fs::write(&original, b"different length").unwrap();

        let mut calls = 0;
        let result = lib.rescan_folder_with_scan(folder.id, |root| {
            calls += 1;
            if calls == 2 {
                std::fs::write(&original, b"original").unwrap();
            }
            crate::import_folder::scan(root)
        });
        assert!(result.unwrap_err().contains("nothing removed"));
        assert!(lib.get_track(id).unwrap().is_some());
        assert_eq!(lib.rescan_folder(folder.id).unwrap().removed, 0);
    }

    #[test]
    fn rescan_preserves_extracted_audio_without_original_and_removes_only_missing_track() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&sources, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&sources, true, false).unwrap();
        let first =
            super::super::tests::add_test_looper_track(&lib, library.path(), "first", &hash);
        // The helper uses sound ID 0, so use another hash for the second group.
        let other_hash = sha256_hex(b"other");
        let second =
            super::super::tests::add_test_looper_track(&lib, library.path(), "second", &other_hash);
        lib.record_folder_source(&original, &hash, true).unwrap();
        lib.record_folder_source(&original, &other_hash, true)
            .unwrap();
        let playlist = lib.create_playlist("Practice").unwrap();
        lib.add_track_to_playlist(playlist.id, first).unwrap();
        lib.add_track_to_playlist(playlist.id, second).unwrap();
        lib.set_favorite(first, true).unwrap();
        std::fs::remove_file(&original).unwrap();
        let audio = lib.get_track(first).unwrap().unwrap().file_path;
        let gone = lib.get_track(second).unwrap().unwrap().file_path;
        std::fs::remove_file(gone).unwrap();
        let report = lib.rescan_folder(folder.id).unwrap();
        assert_eq!(report.removed, 1);
        assert!(report.paths.is_empty());
        assert!(lib.get_track(first).unwrap().unwrap().favorite);
        assert!(Path::new(&audio).is_file());
        assert!(lib.get_track(second).unwrap().is_none());
        assert_eq!(lib.list_playlists().unwrap()[0].track_ids, vec![first]);
        drop(lib);
        let reopened = Library::open(library.path()).unwrap();
        assert_eq!(reopened.linked_folders().unwrap()[0].path, folder.path);
        assert_eq!(reopened.folders_for_source(&hash).unwrap().len(), 1);
    }

    #[test]
    fn rescan_detects_new_changed_and_unchanged_sources_and_keeps_managed_copy() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let sources = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&sources, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&sources, false, true).unwrap();
        let id =
            super::super::tests::add_test_looper_track(&lib, library.path(), "embedded", &hash);
        let managed = library.path().join("copy.swf");
        std::fs::write(&managed, b"old").unwrap();
        lib.conn.execute("UPDATE tracks SET audio_storage='embedded',file_path=?1,source_path=?1,source_managed=1 WHERE id=?2", rusqlite::params![managed.to_str().unwrap(), id]).unwrap();
        lib.record_folder_source(&original, &hash, true).unwrap();
        assert_eq!(lib.rescan_folder(folder.id).unwrap().unchanged, 1);
        std::fs::write(&original, b"new").unwrap();
        let new = source(&sources, "added.exe", b"added");
        let report = lib.rescan_folder(folder.id).unwrap();
        assert_eq!(report.paths.len(), 2);
        assert!(report.paths.contains(&new));
        assert_eq!(report.removed, 0);
        std::fs::remove_file(&original).unwrap();
        assert_eq!(lib.rescan_folder(folder.id).unwrap().removed, 0);
        assert!(lib.get_track(id).unwrap().is_some());
        std::fs::remove_file(managed).unwrap();
        assert_eq!(lib.rescan_folder(folder.id).unwrap().removed, 1);
    }

    #[test]
    fn rescan_missing_folder_aborts_without_pruning_missing_audio() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source_dir = sources.path().canonicalize().unwrap().join("loopers");
        std::fs::create_dir(&source_dir).unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&source_dir, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&source_dir, false, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "missing", &hash);
        lib.record_folder_source(&original, &hash, true).unwrap();
        std::fs::remove_file(lib.get_track(id).unwrap().unwrap().file_path).unwrap();
        std::fs::remove_dir_all(&source_dir).unwrap();
        assert!(lib.rescan_folder(folder.id).is_err());
        assert!(lib.get_track(id).unwrap().is_some());
        assert!(lib.playback_request(id).unwrap_err().contains("missing"));
    }

    #[test]
    fn migration_from_v10_preserves_catalog_and_adds_empty_folder_registry() {
        let directory = tempfile::tempdir().unwrap();
        let lib = Library::open(directory.path()).unwrap();
        let id =
            super::super::tests::add_test_looper_track(&lib, directory.path(), "preserved", "hash");
        lib.conn.execute_batch("DROP TABLE linked_folder_sources; DROP TABLE linked_folders; PRAGMA user_version=10;").unwrap();
        drop(lib);
        let migrated = Library::open(directory.path()).unwrap();
        assert_eq!(migrated.schema_version().unwrap(), 11);
        assert!(migrated.linked_folders().unwrap().is_empty());
        assert!(migrated.get_track(id).unwrap().unwrap().exists);
    }

    #[test]
    fn rescan_does_not_recreate_deleted_extracted_audio_from_an_unchanged_source() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source_dir = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&source_dir, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&source_dir, true, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "deleted", &hash);
        lib.record_folder_source(&original, &hash, true).unwrap();
        std::fs::remove_file(lib.get_track(id).unwrap().unwrap().file_path).unwrap();
        let report = lib.rescan_folder(folder.id).unwrap();
        assert_eq!(report.removed, 1);
        assert!(report.paths.is_empty());
        assert!(Path::new(&original).is_file());
        assert!(lib.rescan_folder(folder.id).unwrap().paths.is_empty());
    }

    #[test]
    fn rescan_relocates_an_identical_embedded_source_without_losing_track_identity() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source_dir = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&source_dir, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&source_dir, false, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "moved", &hash);
        lib.conn.execute("UPDATE tracks SET audio_storage='embedded',file_path=?1,source_path=?1,source_managed=0 WHERE id=?2", rusqlite::params![original, id]).unwrap();
        lib.record_folder_source(&original, &hash, true).unwrap();
        let moved = source_dir.join("renamed.swf");
        std::fs::rename(&original, &moved).unwrap();
        let scan = lib.rescan_folder(folder.id).unwrap();
        assert_eq!(scan.removed, 0);
        assert!(scan.paths.is_empty());
        let track = lib.get_track(id).unwrap().unwrap();
        assert_eq!(Path::new(&track.file_path), moved);
        assert!(track.exists);
    }

    #[cfg(unix)]
    #[test]
    fn rescan_rejects_changed_volume_identity_and_keeps_all_entries() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let folder = lib.link_folder(sources.path(), true, false).unwrap();
        let id =
            super::super::tests::add_test_looper_track(&lib, library.path(), "missing", "hash");
        lib.record_folder_source(
            Path::new(&folder.path).join("old.swf").to_str().unwrap(),
            "hash",
            true,
        )
        .unwrap();
        std::fs::remove_file(lib.get_track(id).unwrap().unwrap().file_path).unwrap();
        lib.conn
            .execute(
                "UPDATE linked_folders SET device_id='not-the-same-volume' WHERE id=?1",
                [folder.id],
            )
            .unwrap();
        assert!(lib.rescan_folder(folder.id).unwrap_err().contains("volume"));
        assert!(lib.get_track(id).unwrap().is_some());
    }

    #[test]
    fn rescan_removes_missing_audio_even_when_its_looper_subdirectory_was_deleted() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let folder = lib.link_folder(sources.path(), true, false).unwrap();
        let id =
            super::super::tests::add_test_looper_track(&lib, library.path(), "missing", "hash");
        lib.record_folder_source(
            Path::new(&folder.path).join("old.swf").to_str().unwrap(),
            "hash",
            true,
        )
        .unwrap();
        let missing = library.path().join("deleted-looper").join("loop.wav");
        lib.conn
            .execute(
                "UPDATE tracks SET file_path=?1 WHERE id=?2",
                rusqlite::params![missing.to_str().unwrap(), id],
            )
            .unwrap();
        assert_eq!(lib.rescan_folder(folder.id).unwrap().removed, 1);
        assert!(lib.get_track(id).unwrap().is_none());
    }

    #[test]
    fn rescan_removes_changed_embedded_original_but_not_unrelated_tracks() {
        let library = tempfile::tempdir().unwrap();
        let sources = tempfile::tempdir().unwrap();
        let source_dir = sources.path().canonicalize().unwrap();
        let lib = Library::open(library.path()).unwrap();
        let original = source(&source_dir, "old.swf", b"old");
        let hash = sha256_hex(b"old");
        let folder = lib.link_folder(&source_dir, false, false).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, library.path(), "old", &hash);
        let other = super::super::tests::add_test_looper_track(
            &lib,
            library.path(),
            "unrelated",
            "unrelated",
        );
        lib.conn.execute("UPDATE tracks SET audio_storage='embedded',file_path=?1,source_path=?1,source_managed=0 WHERE id=?2", rusqlite::params![original, id]).unwrap();
        lib.record_folder_source(&original, &hash, true).unwrap();
        std::fs::write(&original, b"changed").unwrap();
        let scan = lib.rescan_folder(folder.id).unwrap();
        assert_eq!(scan.removed, 1);
        assert_eq!(scan.paths, vec![original.clone()]);
        assert!(Path::new(&original).is_file());
        assert!(lib.get_track(other).unwrap().is_some());
    }
}
