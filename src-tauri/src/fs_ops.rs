//! Filesystem moves that must not replace a destination created concurrently.
use std::{io, path::Path};

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "android"))]
pub(crate) fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(target_os = "windows")]
pub(crate) fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
    }
    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }
    let source = wide(source)?;
    let destination = wide(destination)?;
    // SAFETY: both buffers are NUL-terminated and valid for the call. Zero
    // flags forbid destination replacement and cross-volume copy/delete.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    target_os = "windows"
)))]
pub(crate) fn rename_noreplace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_never_overwrites_an_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("destination");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&destination, b"destination").unwrap();
        assert!(rename_noreplace(&source, &destination).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert_eq!(std::fs::read(&destination).unwrap(), b"destination");
        std::fs::remove_file(&destination).unwrap();
        rename_noreplace(&source, &destination).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"source");
    }

    #[cfg(unix)]
    #[test]
    fn move_rejects_a_dangling_destination_symlink_and_preserves_source_links() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let destination = directory.path().join("destination");
        let target = directory.path().join("missing");
        std::os::unix::fs::symlink(&target, &source).unwrap();
        std::os::unix::fs::symlink(&target, &destination).unwrap();
        assert!(rename_noreplace(&source, &destination).is_err());
        assert_eq!(std::fs::read_link(&source).unwrap(), target);
        assert_eq!(std::fs::read_link(&destination).unwrap(), target);
        std::fs::remove_file(&destination).unwrap();
        rename_noreplace(&source, &destination).unwrap();
        assert_eq!(std::fs::read_link(&destination).unwrap(), target);
    }
}
