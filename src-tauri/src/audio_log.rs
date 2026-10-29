//! Persistent, privacy-conscious diagnostics for audio output routing.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRY_CHARS: usize = 4 * 1024;

#[derive(Default)]
struct AudioLog {
    path: Mutex<Option<PathBuf>>,
}

impl AudioLog {
    fn prepare_library_root(root: &Path) -> io::Result<PathBuf> {
        let root = root.canonicalize()?;
        let log_dir = root.join("log");
        fs::create_dir_all(&log_dir)?;
        let log_dir = log_dir.canonicalize()?;
        if !log_dir.starts_with(&root) || !log_dir.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "audio log directory escapes the library",
            ));
        }
        let path = log_dir.join("audio-output.log");
        open_log_file(&path)?;
        Ok(path)
    }

    fn activate(&self, path: PathBuf) {
        *self
            .path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path);
        #[cfg(target_os = "macos")]
        let (os_version, hardware_arch, rosetta) = (
            command_value("/usr/bin/sw_vers", &["-productVersion"])
                .unwrap_or_else(|| "unknown".to_string()),
            command_value("/usr/sbin/sysctl", &["-n", "hw.machine"])
                .unwrap_or_else(|| "unknown".to_string()),
            command_value("/usr/sbin/sysctl", &["-in", "sysctl.proc_translated"])
                .map(|value| if value == "1" { "yes" } else { "no" })
                .unwrap_or("unknown"),
        );
        #[cfg(not(target_os = "macos"))]
        let (os_version, hardware_arch, rosetta) = (
            "unavailable".to_string(),
            "not_applicable".to_string(),
            "not_applicable",
        );
        self.write(&format!(
            "session_start version={} os={} os_version={} build_arch={} hardware_arch={} rosetta_translated={} pid={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            os_version,
            std::env::consts::ARCH,
            hardware_arch,
            rosetta,
            std::process::id(),
        ));
    }

    #[cfg(test)]
    fn set_library_root(&self, root: &Path) -> io::Result<()> {
        self.activate(Self::prepare_library_root(root)?);
        Ok(())
    }

    fn write(&self, message: &str) {
        let message = single_line(message);
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let line = format!("{timestamp_ms} {message}");
        eprintln!("{line}");

        let state = self
            .path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(path) = state.as_deref() else {
            return;
        };
        // set_library_root stored a canonical parent. Refuse a later directory
        // replacement rather than following it to another location.
        let parent = path.parent();
        if parent.and_then(|dir| dir.canonicalize().ok()).as_deref() != parent {
            eprintln!("[oLooper audio] diagnostic log directory changed; log write skipped");
            return;
        }
        if let Err(error) = append_line(path, &line) {
            eprintln!("[oLooper audio] could not write diagnostic log: {error}");
        }
    }
}

static AUDIO_LOG: OnceLock<AudioLog> = OnceLock::new();

#[cfg(target_os = "macos")]
fn command_value(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Prepare without changing the active library's diagnostic destination.
pub(crate) fn prepare_library_root(root: &Path) -> io::Result<PathBuf> {
    AudioLog::prepare_library_root(root)
}

/// Activate only after the owning library selection has won admission.
pub(crate) fn activate_library_root(path: PathBuf) {
    AUDIO_LOG.get_or_init(AudioLog::default).activate(path);
}

/// Write an audio diagnostic to stderr and, after library initialization, to
/// the persistent audio log. Call only from control/error paths, never the
/// real-time sample callback.
pub(crate) fn write(message: &str) {
    AUDIO_LOG.get_or_init(AudioLog::default).write(message);
}

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    let mut file = open_log_file(path)?;
    if file.metadata()?.len() >= MAX_LOG_BYTES {
        drop(file);
        let previous = path.with_file_name("audio-output.previous.log");
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(path, previous)?;
        file = open_log_file(path)?;
    }
    writeln!(file, "{}", single_line(line))
}

fn open_log_file(path: &Path) -> io::Result<fs::File> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "audio log is not a regular file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    // Reject a last-component symlink even if the file is replaced after the
    // metadata check. Nonblocking open also avoids waiting on a swapped FIFO.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "audio log is not a regular file",
        ));
    }
    Ok(file)
}

fn single_line(message: &str) -> String {
    message
        .chars()
        .map(|character| match character {
            '\n' | '\r' | '\0' => ' ',
            other => other,
        })
        .take(MAX_ENTRY_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_audio_log_inside_library_log_directory() {
        let temp = tempfile::tempdir().unwrap();
        let log = AudioLog::default();
        log.set_library_root(temp.path()).unwrap();
        log.write("output_selected device=DJM-S11 pair=1-2");

        let path = temp.path().join("log/audio-output.log");
        let contents = fs::read_to_string(path).unwrap();
        assert!(contents.contains("session_start version="));
        assert!(contents.contains("output_selected device=DJM-S11 pair=1-2"));
    }

    #[test]
    fn preparing_another_library_does_not_change_the_active_log() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let log = AudioLog::default();
        log.set_library_root(first.path()).unwrap();
        let prepared = AudioLog::prepare_library_root(second.path()).unwrap();
        log.write("before activation");
        assert!(
            fs::read_to_string(first.path().join("log/audio-output.log"))
                .unwrap()
                .contains("before activation")
        );
        assert!(
            !fs::read_to_string(second.path().join("log/audio-output.log"))
                .unwrap()
                .contains("before activation")
        );
        log.activate(prepared);
        log.write("after activation");
        assert!(
            fs::read_to_string(second.path().join("log/audio-output.log"))
                .unwrap()
                .contains("after activation")
        );
    }

    #[test]
    fn log_entries_are_single_line_and_rotate_at_the_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audio-output.log");
        fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        append_line(&path, "1234 stream_error=bad\nnext_line").unwrap();

        let previous = temp.path().join("audio-output.previous.log");
        assert_eq!(fs::metadata(previous).unwrap().len(), MAX_LOG_BYTES);
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "1234 stream_error=bad next_line\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_log_directory_and_file_symlinks_outside_the_library() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("audio-output.log");
        fs::write(&sentinel, b"do not alter").unwrap();
        symlink(outside.path(), root.path().join("log")).unwrap();
        assert!(AudioLog::default().set_library_root(root.path()).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"do not alter");

        fs::remove_file(root.path().join("log")).unwrap();
        fs::create_dir(root.path().join("log")).unwrap();
        symlink(&sentinel, root.path().join("log/audio-output.log")).unwrap();
        assert!(AudioLog::default().set_library_root(root.path()).is_err());
        assert!(append_line(&root.path().join("log/audio-output.log"), "message").is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"do not alter");
    }

    #[cfg(unix)]
    #[test]
    fn skips_log_writes_if_the_directory_is_replaced_after_initialization() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let sentinel = outside.path().join("audio-output.log");
        fs::write(&sentinel, b"do not alter").unwrap();
        let log = AudioLog::default();
        log.set_library_root(root.path()).unwrap();
        fs::rename(root.path().join("log"), root.path().join("old-log")).unwrap();
        symlink(outside.path(), root.path().join("log")).unwrap();
        log.write("must not reach the external file");
        assert_eq!(fs::read(&sentinel).unwrap(), b"do not alter");
    }
}
