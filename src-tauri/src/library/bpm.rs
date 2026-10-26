use super::*;
use crate::bpm_jobs::BpmScope;

// Only one preview may retain decoded PCM; stale frontend requests are ignored
// logically, but must not accumulate buffers while waiting for the work guard.
static PREVIEW: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize)]
pub struct TempoSuggestion {
    pub track_id: i64,
    pub bpm: Option<f64>,
    pub confidence: Option<f64>,
    pub duration_frames: usize,
    pub sample_rate: u32,
    pub assumed_meter: Option<String>,
    pub bars: Option<u32>,
}

pub(crate) enum BpmOutcome {
    Updated(Box<Track>),
    Protected,
    Changed,
    NoEstimate,
}

fn protected(track: &Track) -> bool {
    track.bpm.is_some()
        && (track.bpm_source.as_deref() != Some("analyzed") || track.bpm_confidence.is_none())
}

fn identity(path: &str) -> Result<(u64, Option<std::time::SystemTime>), String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok((metadata.len(), metadata.modified().ok()))
}

impl Library {
    /// Preview the complete canonical loop. Never persist a BPM, normalize tags,
    /// or alter the playing/practice region, including for embedded sources.
    pub fn analyze_bpm(&self, id: i64) -> Result<TempoSuggestion, String> {
        let _preview = PREVIEW
            .try_lock()
            .map_err(|_| "Another tempo preview is running. Please retry shortly.".to_string())?;
        let track = self
            .get_track(id)?
            .ok_or_else(|| format!("track {id} not found"))?;
        let original_identity = identity(&track.file_path)?;
        let buffer = self.playback_request(id)?.decode()?;
        let estimate = crate::analysis::estimate_with_context(
            &buffer,
            crate::analysis::TempoContext::PerfectLoop4_4,
        );
        if identity(&track.file_path)? != original_identity {
            return Err("Audio changed during tempo analysis. Please retry.".into());
        }
        // Recover the integer bar count before UI rounding. At <=15 minutes,
        // the detector's 0.1 BPM rounding cannot move this by half a bar.
        let bars = estimate.as_ref().map(|value| {
            (value.bpm * buffer.frames() as f64 / (240.0 * f64::from(buffer.rate))).round() as u32
        });
        Ok(TempoSuggestion {
            track_id: id,
            bpm: estimate.as_ref().map(|value| value.bpm),
            confidence: estimate.as_ref().map(|value| value.confidence),
            duration_frames: buffer.frames(),
            sample_rate: buffer.rate,
            assumed_meter: estimate.as_ref().map(|_| "4/4".into()),
            bars,
        })
    }

    pub(crate) fn bpm_scope_ids(&self, scope: &BpmScope) -> Result<Vec<i64>, String> {
        const MAX_TRACKS: usize = 100_000;
        let (sql, parameter) = match scope {
            BpmScope::Library => ("SELECT id FROM tracks WHERE ?1 IS NULL ORDER BY id LIMIT 100001", rusqlite::types::Value::Null),
            BpmScope::Looper { source_hash } => {
                if source_hash.is_empty() || source_hash.len() > 256 {
                    return Err("invalid looper hash".into());
                }
                ("SELECT id FROM tracks WHERE source_hash=?1 ORDER BY id LIMIT 100001", source_hash.clone().into())
            }
            BpmScope::Playlist { playlist_id } => (
                "SELECT DISTINCT track_id FROM playlist_tracks WHERE playlist_id=?1 ORDER BY track_id LIMIT 100001",
                (*playlist_id).into(),
            ),
        };
        let mut statement = self.conn.prepare(sql).map_err(|error| error.to_string())?;
        let ids = statement
            .query_map([parameter], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|error| error.to_string())?;
        if ids.is_empty() {
            return Err("No tracks to analyze".into());
        }
        if ids.len() > MAX_TRACKS {
            return Err(
                "BPM analysis supports at most 100,000 tracks per job; select a smaller collection"
                    .into(),
            );
        }
        Ok(ids)
    }

    pub(crate) fn reanalyze_bpm_track(&self, id: i64) -> Result<BpmOutcome, String> {
        crate::check_cancelled()?;
        let original = self
            .get_track(id)?
            .ok_or_else(|| format!("track {id} not found"))?;
        if protected(&original) {
            return Ok(BpmOutcome::Protected);
        }
        let request = self.playback_request(id)?;
        let original_identity = identity(&original.file_path)?;
        // File-authored BPM is authoritative. Reading here never normalizes tags
        // or creates markers, unlike the interactive metadata migration path.
        if original.audio_storage != "embedded"
            && serato::read_audio_file(Path::new(&original.file_path))?
                .metadata
                .bpm
                .is_some()
        {
            return Ok(BpmOutcome::Protected);
        }
        let buffer = request.decode()?;
        crate::check_cancelled()?;
        // An explicit library reanalysis treats the selected tracks as loops,
        // including custom audio, while generic automatic imports remain generic.
        let estimate = crate::analysis::estimate_with_context(
            &buffer,
            crate::analysis::TempoContext::PerfectLoop4_4,
        );
        crate::check_cancelled()?;
        let Some(estimate) = estimate else {
            return Ok(BpmOutcome::NoEstimate);
        };
        let _guard = self.operations.lock.lock();
        crate::check_cancelled()?;
        self.commit_bpm_analysis(&original, original_identity, estimate)
    }

    fn commit_bpm_analysis(
        &self,
        original: &Track,
        original_identity: (u64, Option<std::time::SystemTime>),
        estimate: crate::analysis::BpmEstimate,
    ) -> Result<BpmOutcome, String> {
        let Some(current) = self.get_track(original.id)? else {
            return Ok(BpmOutcome::Changed);
        };
        if protected(&current)
            || current.bpm != original.bpm
            || current.bpm_source != original.bpm_source
            || current.bpm_confidence != original.bpm_confidence
            || current.file_path != original.file_path
            || current.source_hash != original.source_hash
            || current.source_sound_id != original.source_sound_id
            || current.audio_storage != original.audio_storage
            || current.total_frames != original.total_frames
            || identity(&current.file_path)? != original_identity
        {
            return Ok(BpmOutcome::Changed);
        }
        Ok(BpmOutcome::Updated(Box::new(self.update_bpm(
            original.id,
            estimate.bpm,
            Some(estimate.confidence),
            false,
        )?)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manual_confirmation_during_analysis_wins_even_without_a_timestamp_change() {
        let root = tempfile::tempdir().unwrap();
        let lib = Library::open(root.path()).unwrap();
        let id = super::super::tests::add_test_looper_track(&lib, root.path(), "beat", "hash");
        lib.update_bpm(id, 100.0, Some(0.2), false).unwrap();
        let original = lib.get_track(id).unwrap().unwrap();
        let file_identity = identity(&original.file_path).unwrap();
        lib.update_metadata(id, "beat", Some(100.0), "", true)
            .unwrap();
        lib.conn
            .execute(
                "UPDATE tracks SET updated_at=?1 WHERE id=?2",
                rusqlite::params![original.updated_at, id],
            )
            .unwrap();
        let _guard = lib.operations.lock.lock();
        assert!(matches!(
            lib.commit_bpm_analysis(
                &original,
                file_identity,
                crate::analysis::BpmEstimate {
                    bpm: 120.0,
                    confidence: 0.3
                }
            )
            .unwrap(),
            BpmOutcome::Changed
        ));
        assert_eq!(lib.get_track(id).unwrap().unwrap().bpm, Some(100.0));
        assert_eq!(
            lib.get_track(id).unwrap().unwrap().bpm_source.as_deref(),
            Some("manual")
        );
    }
}
