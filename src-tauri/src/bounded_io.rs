use std::io::Read;

/// Open first without waiting for FIFO writers, then validate that descriptor.
pub(crate) fn open_regular(path: impl AsRef<std::path::Path>) -> std::io::Result<std::fs::File> {
    open_regular_with_access(path.as_ref(), false)
}

/// Open an existing regular file for in-place metadata updates.
pub(crate) fn open_regular_for_update(
    path: impl AsRef<std::path::Path>,
) -> std::io::Result<std::fs::File> {
    open_regular_with_access(path.as_ref(), true)
}

fn open_regular_with_access(path: &std::path::Path, write: bool) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(write);
    // Opening a FIFO for reading can otherwise block before we can inspect it.
    // O_NONBLOCK has no effect on ordinary files; inspect the opened descriptor
    // rather than a path that could be replaced between inspection and opening.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "input is not a regular file",
        ));
    }
    Ok(file)
}

/// Inspect and read the same regular descriptor, including a growth cap.
pub(crate) fn read(path: impl AsRef<std::path::Path>, maximum: u64) -> Result<Vec<u8>, String> {
    let file = open_regular(path).map_err(|e| format!("cannot open file: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let limit = maximum.min(crate::memory::working_budget(maximum as usize) as u64);
    if metadata.len() > limit {
        return Err(format!(
            "file exceeds the current input budget ({limit} bytes)"
        ));
    }
    let mut data = Vec::new();
    read_into(file, &mut data, limit)?;
    if data.len() as u64 > limit {
        return Err("file grew beyond the input limit".into());
    }
    Ok(data)
}

pub(crate) fn read_into(reader: impl Read, data: &mut Vec<u8>, maximum: u64) -> Result<(), String> {
    let mut reader = reader.take(maximum + 1);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        crate::check_cancelled()?;
        let count = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        data.extend_from_slice(&chunk[..count]);
        if data.len() as u64 > maximum {
            return Err("input exceeds its size limit".into());
        }
    }
}

pub(crate) fn copy(
    file: &mut std::fs::File,
    output: &mut impl std::io::Write,
    maximum: u64,
) -> std::io::Result<u64> {
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "copy source exceeds its regular-file limit",
        ));
    }
    let mut source = file.take(maximum + 1);
    let mut chunk = [0u8; 64 * 1024];
    let mut copied = 0u64;
    loop {
        crate::check_cancelled().map_err(std::io::Error::other)?;
        let count = source.read(&mut chunk)?;
        if count == 0 {
            return Ok(copied);
        }
        copied += count as u64;
        if copied > maximum {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "copy source grew beyond its limit",
            ));
        }
        output.write_all(&chunk[..count])?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_oversized_and_non_regular_inputs() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("input");
        std::fs::write(&path, b"12345").unwrap();
        assert!(read(&path, 4).is_err());
        assert_eq!(read(&path, 5).unwrap(), b"12345");
        assert!(read(root.path(), 1024).is_err());
        #[cfg(unix)]
        assert!(read("/dev/zero", 1024).is_err());
    }
    #[test]
    fn bounds_actual_bytes_independently_of_metadata() {
        let mut bytes = Vec::new();
        assert!(read_into(std::io::repeat(0), &mut bytes, 3).is_err());
        assert_eq!(bytes.len(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        use std::sync::mpsc;
        use std::time::Duration;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("input");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid, NUL-terminated path in the temporary directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(read(path, 1024));
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("opening a FIFO must not wait for a writer");
        assert!(result.unwrap_err().contains("not a regular file"));
    }
}
