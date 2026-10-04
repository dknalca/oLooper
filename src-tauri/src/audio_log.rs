//! Persistent, privacy-conscious diagnostics for CoreAudio output routing.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
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
    fn set_library_root(&self, root: &Path) -> io::Result<()> {
        let log_dir = root.join("log");
        fs::create_dir_all(&log_dir)?;
        let path = log_dir.join("audio-output.log");
        OpenOptions::new().create(true).append(true).open(&path)?;
        *self
            .path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path);
        let os_version = command_value("/usr/bin/sw_vers", &["-productVersion"])
            .unwrap_or_else(|| "unknown".to_string());
        let hardware_arch = command_value("/usr/sbin/sysctl", &["-n", "hw.machine"])
            .unwrap_or_else(|| "unknown".to_string());
        let rosetta = command_value("/usr/sbin/sysctl", &["-in", "sysctl.proc_translated"])
            .map(|value| if value == "1" { "yes" } else { "no" })
            .unwrap_or("unknown");
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
        if let Err(error) = append_line(path, &line) {
            eprintln!("[oLooper audio] could not write diagnostic log: {error}");
        }
    }
}

static AUDIO_LOG: OnceLock<AudioLog> = OnceLock::new();

fn command_value(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Direct future audio diagnostics to `<library root>/log/audio-output.log`.
pub(crate) fn set_library_root(root: &Path) -> io::Result<()> {
    AUDIO_LOG
        .get_or_init(AudioLog::default)
        .set_library_root(root)
}

/// Write an audio diagnostic to stderr and, after library initialization, to
/// the persistent audio log. Call only from control/error paths, never the
/// real-time sample callback.
pub(crate) fn write(message: &str) {
    AUDIO_LOG.get_or_init(AudioLog::default).write(message);
}

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES) {
        let previous = path.with_file_name("audio-output.previous.log");
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(path, previous)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", single_line(line))
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
}
