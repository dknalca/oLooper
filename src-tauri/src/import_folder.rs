use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 100_000;
const MAX_LOOPERS: usize = 10_000;

/// Discover files only; never follow symlinks or execute projector files.
pub(crate) fn scan(root: &Path) -> Result<Vec<String>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Cannot open folder: {error}"))?;
    if !root.is_dir() {
        return Err("Choose a folder to import".to_string());
    }
    let mut pending: Vec<PathBuf> = vec![root];
    let mut files = Vec::new();
    let mut visited = 0;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| format!("Cannot read folder entry: {error}"))?;
            visited += 1;
            if visited > MAX_ENTRIES {
                return Err("Folder is too large to scan (100,000 entries maximum). Choose a smaller folder.".to_string());
            }
            let kind = entry
                .file_type()
                .map_err(|error| format!("Cannot inspect entry: {error}"))?;
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("swf") || ext.eq_ignore_ascii_case("exe")
                    })
            {
                files.push(
                    path.to_str()
                        .ok_or("A looper path is not valid Unicode")?
                        .to_string(),
                );
                if files.len() > MAX_LOOPERS {
                    return Err(
                        "Folder contains more than 10,000 loopers. Choose a smaller folder."
                            .to_string(),
                    );
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_nested_loopers_only_in_stable_order() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("nested")).unwrap();
        for name in ["a.SWF", "nested/b.ExE", "ignore.mp3", "ignore.txt"] {
            std::fs::write(root.path().join(name), b"fixture").unwrap();
        }
        let found = scan(root.path()).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[0].ends_with("a.SWF"));
        assert!(found[1].ends_with("b.ExE"));
        assert!(scan(&root.path().join("a.SWF")).is_err());
    }

    #[test]
    fn empty_folder_has_no_loopers() {
        let root = tempfile::tempdir().unwrap();
        assert!(scan(root.path()).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_files_and_directory_cycles() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("external.swf"), b"fixture").unwrap();
        std::os::unix::fs::symlink(root.path(), root.path().join("cycle")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("external.swf"),
            root.path().join("linked.swf"),
        )
        .unwrap();
        assert!(scan(root.path()).unwrap().is_empty());
    }
}
