//! One owner process per catalog; reentrant serialization of file mutations.
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

pub(super) struct Operations {
    pub lock: parking_lot::ReentrantMutex<()>,
    _lease: File,
}

pub(super) fn acquire(root: &Path) -> Result<Arc<Operations>, String> {
    static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Weak<Operations>>>> = OnceLock::new();
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut roots = ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?;
    roots.retain(|_, value| value.strong_count() > 0);
    if let Some(operations) = roots.get(&root).and_then(Weak::upgrade) {
        return Ok(operations);
    }
    let path = root.join(".olooper.lock");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("invalid library lock file".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("cannot open library lock: {e}"))?;
    fs2::FileExt::try_lock_exclusive(&file)
        .map_err(|_| "This library is already open in another oLooper process".to_string())?;
    let operations = Arc::new(Operations {
        lock: parking_lot::ReentrantMutex::new(()),
        _lease: file,
    });
    roots.insert(root, Arc::downgrade(&operations));
    Ok(operations)
}
