//! Short-lived catalog observations, never authorization to load or mutate a file.

use std::collections::HashMap;

const MAX_ENTRIES: usize = 4096;
const MAX_PATH_BYTES: usize = 512 * 1024;

/// Reuse positive and negative observations only within one catalog operation.
/// Once full, keep probing uncached paths rather than guessing availability.
pub(super) struct FileAvailability<F> {
    probe: F,
    entries: HashMap<String, bool>,
    path_bytes: usize,
}

impl<F: FnMut(&str) -> bool> FileAvailability<F> {
    pub(super) fn new(probe: F) -> Self {
        Self {
            probe,
            entries: HashMap::new(),
            path_bytes: 0,
        }
    }

    pub(super) fn is_file(&mut self, path: &str) -> bool {
        if let Some(exists) = self.entries.get(path) {
            return *exists;
        }
        let exists = (self.probe)(path);
        if self.entries.len() < MAX_ENTRIES
            && path.len() <= MAX_PATH_BYTES.saturating_sub(self.path_bytes)
        {
            self.entries.insert(path.to_owned(), exists);
            self.path_bytes += path.len();
        }
        exists
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn repeated_positive_and_negative_paths_share_one_probe() {
        let calls = Cell::new(0);
        let mut availability = FileAvailability::new(|path: &str| {
            calls.set(calls.get() + 1);
            path == "present.swf"
        });
        for _ in 0..100 {
            assert!(availability.is_file("present.swf"));
            assert!(!availability.is_file("missing.exe"));
        }
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn entry_limit_falls_back_to_real_probes_and_keeps_cached_paths() {
        let calls = Cell::new(0);
        let mut availability = FileAvailability::new(|_: &str| {
            calls.set(calls.get() + 1);
            true
        });
        for index in 0..MAX_ENTRIES {
            assert!(availability.is_file(&index.to_string()));
        }
        for _ in 0..2 {
            assert!(availability.is_file("overflow"));
            assert!(availability.is_file("0"));
        }
        assert_eq!(availability.entries.len(), MAX_ENTRIES);
        assert_eq!(calls.get(), MAX_ENTRIES + 2);
    }

    #[test]
    fn retained_path_bytes_are_bounded_and_uncached_results_stay_fresh() {
        let present = Cell::new(true);
        let mut availability = FileAvailability::new(|_: &str| present.get());
        let full_path = "a".repeat(MAX_PATH_BYTES);
        assert!(availability.is_file(&full_path));
        assert!(availability.is_file("overflow"));
        present.set(false);
        assert!(!availability.is_file("overflow"));
        assert!(availability.is_file(&full_path));
        assert_eq!(availability.path_bytes, MAX_PATH_BYTES);
        assert_eq!(availability.entries.len(), 1);
    }

    #[test]
    fn oversized_paths_are_probed_but_not_retained() {
        let mut availability = FileAvailability::new(|_: &str| false);
        assert!(!availability.is_file(&"a".repeat(MAX_PATH_BYTES + 1)));
        assert!(availability.entries.is_empty());
        assert_eq!(availability.path_bytes, 0);
    }
}
