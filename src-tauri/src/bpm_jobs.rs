//! One bounded, cancellable BPM job; catalog updates stay owned by its root.
use crate::library::{BpmOutcome, Library, Track};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Emitter;

#[derive(Default)]
struct ProgressThrottle(Option<std::time::Instant>);

impl ProgressThrottle {
    fn admit(&mut self, terminal: bool, now: std::time::Instant) -> bool {
        if terminal
            || self.0.is_none_or(|last| {
                now.duration_since(last) >= std::time::Duration::from_millis(150)
            })
        {
            self.0 = Some(now);
            true
        } else {
            false
        }
    }
}

thread_local! {
    static CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn cancelled() -> bool {
    CANCEL.with(|flag| {
        flag.borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum BpmScope {
    Library,
    Looper { source_hash: String },
    Playlist { playlist_id: i64 },
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct BpmReport {
    pub total: usize,
    pub processed: usize,
    pub updated: usize,
    pub protected: usize,
    pub changed_since_start: usize,
    pub no_estimate: usize,
    pub failed: usize,
    pub unprocessed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct BpmProgress {
    pub job_id: String,
    pub library_root: PathBuf,
    pub state: String,
    pub report: BpmReport,
    pub current_track_id: Option<i64>,
    pub updated_track: Option<Track>,
    pub error: Option<String>,
}

impl BpmProgress {
    pub fn done(&self) -> bool {
        matches!(self.state.as_str(), "completed" | "cancelled" | "failed")
    }
}

struct Job {
    progress: Arc<Mutex<BpmProgress>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub(crate) struct BpmJobs {
    job: Mutex<Option<Job>>,
}

impl BpmJobs {
    pub fn status(&self) -> Result<Option<BpmProgress>, String> {
        let job = self.job.lock().map_err(|error| error.to_string())?;
        job.as_ref()
            .map(|job| {
                job.progress
                    .lock()
                    .map(|progress| progress.clone())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        if let Some(job) = self.job.lock().map_err(|error| error.to_string())?.as_ref() {
            if job
                .progress
                .lock()
                .map_err(|error| error.to_string())?
                .job_id
                == job_id
            {
                job.cancel.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    pub fn cancel_root(&self, root: &Path) {
        if let Ok(job) = self.job.lock() {
            if let Some(job) = job.as_ref() {
                if job
                    .progress
                    .lock()
                    .is_ok_and(|progress| progress.library_root == root)
                {
                    job.cancel.store(true, Ordering::Relaxed);
                }
            }
        }
    }

    pub fn start(
        &self,
        root: PathBuf,
        ids: Vec<i64>,
        job_id: String,
        app: tauri::AppHandle,
    ) -> Result<String, String> {
        if job_id.is_empty()
            || job_id.len() > 128
            || !job_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_:".contains(&byte))
        {
            return Err("invalid BPM job ID".into());
        }
        let mut slot = self.job.lock().map_err(|error| error.to_string())?;
        if let Some(job) = slot.as_ref() {
            if !job
                .progress
                .lock()
                .map_err(|error| error.to_string())?
                .done()
            {
                return Err("A BPM analysis is already running".into());
            }
        }
        let progress = Arc::new(Mutex::new(BpmProgress {
            job_id: job_id.clone(),
            library_root: root.clone(),
            state: "running".into(),
            report: BpmReport {
                total: ids.len(),
                unprocessed: ids.len(),
                ..Default::default()
            },
            current_track_id: None,
            updated_track: None,
            error: None,
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_progress = progress.clone();
        let worker_cancel = cancel.clone();
        std::thread::Builder::new()
            .name("olooper-bpm".into())
            .spawn(move || {
                CANCEL.with(|flag| *flag.borrow_mut() = Some(worker_cancel.clone()));
                let mut value = worker_progress
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                let mut throttle = ProgressThrottle::default();
                let mut publish = |value: &BpmProgress| {
                    *worker_progress
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = value.clone();
                    if throttle.admit(value.done(), std::time::Instant::now()) {
                        let _ = app.emit("olooper:bpm-reanalysis-progress", value);
                    }
                };
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let library = Library::open(&root)?;
                    process_tracks(&library, &ids, &mut value, &mut publish)
                }))
                .unwrap_or_else(|_| Err("BPM worker failed unexpectedly".into()));
                value.state = if worker_cancel.load(Ordering::Relaxed) {
                    "cancelled"
                } else if result.is_err() {
                    "failed"
                } else {
                    "completed"
                }
                .into();
                value.error = result.err().filter(|_| value.state != "cancelled");
                value.current_track_id = None;
                value.updated_track = None;
                publish(&value);
                CANCEL.with(|flag| *flag.borrow_mut() = None);
            })
            .map_err(|error| format!("cannot start BPM worker: {error}"))?;
        *slot = Some(Job { progress, cancel });
        Ok(job_id)
    }
}

fn process_tracks(
    library: &Library,
    ids: &[i64],
    progress: &mut BpmProgress,
    publish: &mut impl FnMut(&BpmProgress),
) -> Result<(), String> {
    for id in ids {
        crate::check_cancelled()?;
        progress.current_track_id = Some(*id);
        progress.updated_track = None;
        publish(progress);
        let outcome = library.reanalyze_bpm_track(*id);
        // A committed update must be counted even if cancellation arrived just
        // after its commit. A cancelled decode, however, remains unprocessed.
        match outcome {
            Ok(BpmOutcome::Updated(track)) => {
                progress.report.updated += 1;
                progress.updated_track = Some(*track);
            }
            Ok(BpmOutcome::Protected) => progress.report.protected += 1,
            Ok(BpmOutcome::Changed) => progress.report.changed_since_start += 1,
            Ok(BpmOutcome::NoEstimate) => progress.report.no_estimate += 1,
            Err(error) => {
                crate::check_cancelled()?;
                progress.report.failed += 1;
                if progress.report.errors.len() < 20 {
                    progress.report.errors.push(format!(
                        "Track {id}: {}",
                        error.chars().take(500).collect::<String>()
                    ));
                }
            }
        }
        progress.report.processed += 1;
        progress.report.unprocessed -= 1;
        publish(progress);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_emissions_are_time_bounded_and_terminal_is_never_suppressed() {
        let mut throttle = ProgressThrottle::default();
        let start = std::time::Instant::now();
        let admitted = (0..2000).filter(|_| throttle.admit(false, start)).count();
        assert_eq!(admitted, 1);
        assert!(!throttle.admit(false, start + std::time::Duration::from_millis(149)));
        assert!(throttle.admit(false, start + std::time::Duration::from_millis(150)));
        assert!(throttle.admit(true, start + std::time::Duration::from_millis(150)));
    }

    #[test]
    fn cancellation_preserves_completed_counts() {
        let directory = tempfile::tempdir().unwrap();
        let lib = Library::open(directory.path()).unwrap();
        let first =
            crate::library::tests::add_test_looper_track(&lib, directory.path(), "one", "hash");
        let second =
            crate::library::tests::add_test_looper_track(&lib, directory.path(), "two", "hash-two");
        lib.update_bpm(first, 100.0, None, true).unwrap();
        lib.update_bpm(second, 120.0, None, true).unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        CANCEL.with(|value| *value.borrow_mut() = Some(flag.clone()));
        let mut progress = BpmProgress {
            job_id: "test".into(),
            library_root: directory.path().to_path_buf(),
            state: "running".into(),
            report: BpmReport {
                total: 2,
                unprocessed: 2,
                ..Default::default()
            },
            current_track_id: None,
            updated_track: None,
            error: None,
        };
        let result = process_tracks(&lib, &[first, second], &mut progress, &mut |value| {
            if value.report.processed == 1 {
                flag.store(true, Ordering::Relaxed);
            }
        });
        CANCEL.with(|value| *value.borrow_mut() = None);
        assert!(result.is_err());
        assert_eq!(progress.report.processed, 1);
        assert_eq!(progress.report.protected, 1);
        assert_eq!(progress.report.unprocessed, 1);
        assert_eq!(lib.get_track(second).unwrap().unwrap().bpm, Some(120.0));
    }

    #[test]
    fn per_track_errors_are_bounded_and_do_not_abort_the_remaining_tracks() {
        let directory = tempfile::tempdir().unwrap();
        let lib = Library::open(directory.path()).unwrap();
        let ids: Vec<i64> = (1..=30).collect();
        let mut progress = BpmProgress {
            job_id: "test".into(),
            library_root: directory.path().to_path_buf(),
            state: "running".into(),
            report: BpmReport {
                total: ids.len(),
                unprocessed: ids.len(),
                ..Default::default()
            },
            current_track_id: None,
            updated_track: None,
            error: None,
        };
        process_tracks(&lib, &ids, &mut progress, &mut |_| {}).unwrap();
        assert_eq!(progress.report.failed, 30);
        assert_eq!(progress.report.processed, 30);
        assert_eq!(progress.report.unprocessed, 0);
        assert_eq!(progress.report.errors.len(), 20);
    }
}
