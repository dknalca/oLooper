//! Persistent library: SQLite catalog + audio as normal files.
//!
//! The database is metadata only. Every write path keeps looper directories and
//! `Custom Loops/` human-browsable; file copies go `tmp → validate → rename`
//! and row writes are transactional. Removing a track deletes its library copy,
//! but never its original source file.

use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::import::swf::Sound;

mod serato;

/// Current schema version (`PRAGMA user_version`).
const SCHEMA_VERSION: i32 = 6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub looper_name: String,
    pub file_path: String,
    /// False when the file was moved/deleted outside the app.
    pub exists: bool,
    pub source_type: String,
    pub source_path: String,
    pub source_hash: String,
    pub source_sound_id: i64,
    pub codec: String,
    pub sample_rate: i64,
    pub channels: i64,
    pub duration_ms: i64,
    pub seek_samples: i64,
    pub trimmed_leading: i64,
    pub bpm: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub bpm_source: Option<String>,
    pub primary_cue_ms: i64,
    pub loop_start_ms: i64,
    pub loop_end_ms: i64,
    pub loop_enabled: bool,
    pub loop_start_frame: i64,
    pub loop_end_frame: i64,
    pub loop_origin: String,
    pub loop_quality: f64,
    pub loop_needs_review: bool,
    pub total_frames: i64,
    pub imported_at: i64,
    pub updated_at: i64,
    pub favorite: bool,
    pub tags: String,
    pub last_played_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailedSound {
    pub id: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub looper: String,
    pub added: usize,
    pub already_there: usize,
    pub failed: Vec<FailedSound>,
    pub track_ids: Vec<i64>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn cue_label_for_slot(slot: i64) -> String {
    char::from(b'A' + slot.saturating_sub(1) as u8).to_string()
}

fn ensure_default_serato_cue(metadata: &mut SeratoMetadata) -> bool {
    let mut changed = false;
    if metadata
        .cues
        .iter()
        .find(|cue| cue.slot == 1)
        .is_none_or(|cue| cue.position_ms != 0)
    {
        metadata.cues.retain(|cue| cue.slot != 1);
        metadata.cues.push(SeratoCue {
            slot: 1,
            label: cue_label_for_slot(1),
            position_ms: 0,
        });
        changed = true;
    }
    metadata.cues.sort_by_key(|cue| cue.slot);
    metadata.loops.sort_by_key(|saved| saved.slot);
    changed
}

fn looper_audio_tags(looper: &str) -> (Option<String>, String) {
    for separator in [" - ", " – ", " — ", " ‐ "] {
        if let Some((artist, album)) = looper.split_once(separator) {
            let artist = artist.trim();
            let album = album.trim();
            if !artist.is_empty() && !album.is_empty() {
                return (Some(artist.to_string()), album.to_string());
            }
        }
    }
    (None, looper.trim().to_string())
}

pub fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// Strip path separators, `..`, control chars; cap length. Never empty.
pub fn sanitize_name(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric()
                || matches!(c, ' ' | '-' | '–' | '—' | '‐' | '_' | '.' | '(' | ')')
            {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Collapse repeats of the replacement without allocating per char.
    while s.contains("__") {
        s = s.replace("__", "_");
    }
    let s = s.trim().trim_matches(['.', '_', ' ']).to_string();
    let s: String = s.chars().take(80).collect();
    if s.is_empty() {
        "untitled".to_string()
    } else {
        s
    }
}

/// Legacy SQLite cue/loop entry, read only while migrating old libraries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoopSlot {
    pub id: i64,
    pub track_id: i64,
    pub slot: i64,
    pub label: String,
    pub cue_ms: i64,
    pub loop_start_ms: i64,
    pub loop_end_ms: i64,
    pub enabled: bool,
}

/// A hot cue stored in the track's audio metadata. `slot` is one-based in oLooper;
/// Serato's Markers2 uses zero-based cue indexes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeratoCue {
    pub slot: i64,
    pub label: String,
    pub position_ms: i64,
}

/// A Serato saved loop retained for tag preservation; oLooper does not edit or show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeratoLoop {
    pub slot: i64,
    pub label: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// CUE and BPM values managed by oLooper, plus Serato loops retained on read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SeratoMetadata {
    pub cues: Vec<SeratoCue>,
    pub loops: Vec<SeratoLoop>,
    pub bpm: Option<f64>,
}

pub struct Library {
    conn: Connection,
    pub root: PathBuf,
}

struct QuarantinedFiles {
    directory: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

static NEXT_DELETE_QUARANTINE: AtomicU64 = AtomicU64::new(1);

impl Library {
    /// Open (creating) `root/olooper.db`, making the library root, migrating.
    /// One transaction per migration step; version set only on success.
    pub fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root)
            .and_then(|()| std::fs::create_dir_all(root.join("Custom Loops")))
            .map_err(|e| format!("cannot create library dirs: {e}"))?;
        let conn = Connection::open(root.join("olooper.db"))
            .map_err(|e| format!("cannot open library database: {e}"))?;
        // Enable foreign key enforcement (off by default in SQLite).
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("cannot enable foreign keys: {e}"))?;
        // WAL lets a background import connection write while the main
        // connection serves readers (library list, waveform). Persists in
        // the db file; re-asserted on every open. Busy timeout absorbs
        // short writer/writer contention instead of failing reads.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
            .map_err(|e| format!("cannot set WAL mode: {e}"))?;
        migrate(&conn)?;
        Ok(Self {
            conn,
            root: root.to_path_buf(),
        })
    }

    pub fn schema_version(&self) -> Result<i32, String> {
        self.conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    pub fn list_tracks(&self) -> Result<Vec<Track>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,title,looper_name,file_path,source_type,source_path,source_hash,\
                 source_sound_id,codec,sample_rate,channels,duration_ms,seek_samples,trimmed_leading,\
                 bpm,bpm_confidence,bpm_source,primary_cue_ms,loop_start_ms,\
                   loop_end_ms,loop_enabled,loop_start_frame,loop_end_frame,loop_origin,\
                   loop_quality,loop_needs_review,total_frames,imported_at,updated_at,favorite,tags,last_played_at \
                 FROM tracks ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let file_path: String = r.get(3)?;
                Ok(Track {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    looper_name: r.get(2)?,
                    file_path: file_path.clone(),
                    exists: Path::new(&file_path).is_file(),
                    source_type: r.get(4)?,
                    source_path: r.get(5)?,
                    source_hash: r.get(6)?,
                    source_sound_id: r.get(7)?,
                    codec: r.get(8)?,
                    sample_rate: r.get(9)?,
                    channels: r.get(10)?,
                    duration_ms: r.get(11)?,
                    seek_samples: r.get(12)?,
                    trimmed_leading: r.get(13)?,
                    bpm: r.get(14)?,
                    bpm_confidence: r.get(15)?,
                    bpm_source: r.get(16)?,
                    primary_cue_ms: r.get(17)?,
                    loop_start_ms: r.get(18)?,
                    loop_end_ms: r.get(19)?,
                    loop_enabled: r.get(20)?,
                    loop_start_frame: r.get(21)?,
                    loop_end_frame: r.get(22)?,
                    loop_origin: r.get(23)?,
                    loop_quality: r.get(24)?,
                    loop_needs_review: r.get(25)?,
                    total_frames: r.get(26)?,
                    imported_at: r.get(27)?,
                    updated_at: r.get(28)?,
                    favorite: r.get(29)?,
                    tags: r.get(30)?,
                    last_played_at: r.get(31)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>, String> {
        Ok(self.list_tracks()?.into_iter().find(|t| t.id == id))
    }

    pub fn tablist_import_counts(&self) -> Result<Vec<TablistImportCount>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT source_path,COUNT(*) FROM tracks WHERE source_type='tablist' GROUP BY source_path",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                let count: i64 = row.get(1)?;
                Ok(TablistImportCount {
                    source_path: row.get(0)?,
                    tracks: count.max(0) as usize,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    /// Choose a playable library track at random, avoiding the current track
    /// when another playable track is available.
    pub fn random_track(&self, exclude_id: Option<i64>) -> Result<Option<Track>, String> {
        let mut tracks: Vec<_> = self
            .list_tracks()?
            .into_iter()
            .filter(|track| track.exists)
            .collect();
        if tracks.len() > 1 {
            if let Some(exclude_id) = exclude_id {
                tracks.retain(|track| track.id != exclude_id);
            }
        }
        if tracks.is_empty() {
            return Ok(None);
        }
        let random: i64 = self
            .conn
            .query_row("SELECT random()", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let index = random.unsigned_abs() as usize % tracks.len();
        Ok(Some(tracks.swap_remove(index)))
    }

    /// Insert or return the existing row id on `(source_hash, source_sound_id)`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_track(
        &self,
        title: &str,
        looper_name: &str,
        file_path: &Path,
        source_type: &str,
        source_path: &str,
        source_hash: &str,
        source_sound_id: i64,
        exe_offset: Option<i64>,
        exe_length: Option<i64>,
        codec: &str,
        buf: &crate::player::LoopBuffer,
        seek_samples: i64,
        trimmed_leading: i64,
    ) -> Result<(i64, bool), String> {
        let now = now_secs();
        let duration = buf.duration_ms() as i64;
        let total_frames = buf.frames() as i64;
        let n = self
            .conn
            .execute(
                "INSERT INTO tracks(\
                 title,looper_name,file_path,source_type,source_path,source_hash,source_sound_id,\
                 exe_offset,exe_length,codec,sample_rate,channels,duration_ms,\
                 seek_samples,trimmed_leading,\
                 primary_cue_ms,loop_start_ms,loop_end_ms,loop_enabled,\
                 loop_start_frame,loop_end_frame,loop_origin,loop_quality,loop_needs_review,total_frames,\
                 imported_at,updated_at) \
                   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,\
                   0,0,?13,1,0,?16,'manual',1.0,0,?16,?17,?17) \
                 ON CONFLICT(source_hash,source_sound_id) DO NOTHING",
                rusqlite::params![
                    title,
                    looper_name,
                    file_path.to_str().ok_or("non-UTF8 path")?,
                    source_type,
                    source_path,
                    source_hash,
                    source_sound_id,
                    exe_offset,
                    exe_length,
                    codec,
                    buf.rate as i64,
                    buf.channels as i64,
                    duration,
                    seek_samples,
                    trimmed_leading,
                    total_frames,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
        if n == 1 {
            Ok((self.conn.last_insert_rowid(), true))
        } else {
            let id: i64 = self
                .conn
                .query_row(
                    "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=?2",
                    rusqlite::params![source_hash, source_sound_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            Ok((id, false))
        }
    }

    pub fn update_cue_loop(
        &self,
        id: i64,
        cue_ms: i64,
        start_ms: i64,
        end_ms: i64,
        enabled: bool,
    ) -> Result<Track, String> {
        let t = self
            .get_track(id)?
            .ok_or_else(|| format!("track {id} not found"))?;
        if cue_ms < 0 || cue_ms > t.duration_ms {
            return Err("cue outside track duration".to_string());
        }
        crate::player::check_region(start_ms as u64, end_ms as u64, t.duration_ms as u64)?;
        // Use stored total_frames to avoid round-trip precision loss.
        let rate = t.sample_rate as u32;
        let total = if t.total_frames > 0 {
            t.total_frames as u64
        } else {
            // Fallback for legacy rows without total_frames.
            t.duration_ms as u64 * rate as u64 / 1000
        };
        let start_frame = (start_ms as u64 * rate as u64 / 1000).min(total) as i64;
        let end_frame = ((end_ms as u64 * rate as u64 / 1000).max(1).min(total)) as i64;
        self.conn
            .execute(
                "UPDATE tracks SET primary_cue_ms=?1,loop_start_ms=?2,loop_end_ms=?3,\
                 loop_enabled=?4,loop_start_frame=?5,loop_end_frame=?6,loop_origin='manual',\
                 updated_at=?7 WHERE id=?8",
                rusqlite::params![
                    cue_ms,
                    start_ms,
                    end_ms,
                    enabled,
                    start_frame,
                    end_frame,
                    now_secs(),
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
        self.get_track(id)?
            .ok_or_else(|| format!("track {id} vanished"))
    }

    pub fn update_bpm(
        &self,
        id: i64,
        bpm: f64,
        confidence: Option<f64>,
        manual: bool,
    ) -> Result<Track, String> {
        if !(20.0..=300.0).contains(&bpm) {
            return Err("bpm outside 20–300".to_string());
        }
        self.get_track(id)?
            .ok_or_else(|| format!("track {id} not found"))?;
        let source = if manual { "manual" } else { "analyzed" };
        self.conn
            .execute(
                "UPDATE tracks SET bpm=?1,bpm_confidence=?2,bpm_source=?3,updated_at=?4 \
                 WHERE id=?5",
                rusqlite::params![bpm, confidence, source, now_secs(), id],
            )
            .map_err(|e| e.to_string())?;
        self.get_track(id)?
            .ok_or_else(|| format!("track {id} vanished"))
    }

    /// Delete one catalog track and its library-managed audio copy. The source
    /// path (original SWF/EXE or user file) is never removed.
    pub fn remove_track(&self, id: i64) -> Result<bool, String> {
        let Some(track) = self.get_track(id)? else {
            return Ok(false);
        };
        let remaining: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE source_hash=?1 AND id<>?2",
                rusqlite::params![track.source_hash, id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let last_group_track = remaining == 0 && track.source_type != "custom";
        let file_path = PathBuf::from(&track.file_path);
        let mut candidates = vec![file_path.clone()];
        if last_group_track {
            if let Some(directory) = file_path.parent() {
                candidates.push(directory.join("cover.jpg"));
            }
        }
        let quarantined = self.quarantine_files(&candidates)?;
        let changed = match self.conn.execute("DELETE FROM tracks WHERE id=?1", [id]) {
            Ok(changed) => changed,
            Err(error) => {
                if let Some(quarantined) = &quarantined {
                    self.restore_quarantined(quarantined)?;
                }
                return Err(error.to_string());
            }
        };
        if changed != 1 {
            if let Some(quarantined) = &quarantined {
                self.restore_quarantined(quarantined)?;
            }
            return Ok(false);
        }
        if let Some(quarantined) = quarantined {
            self.purge_quarantined(quarantined)?;
        }
        if last_group_track {
            if let Some(directory) = file_path.parent() {
                let _ = std::fs::remove_dir(directory);
            }
        }
        Ok(true)
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<Track, String> {
        let changed = self
            .conn
            .execute(
                "UPDATE tracks SET favorite=?1,updated_at=?2 WHERE id=?3",
                rusqlite::params![favorite, now_secs(), id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("track {id} not found"));
        }
        self.get_track(id)?
            .ok_or_else(|| format!("track {id} vanished"))
    }

    pub fn update_metadata(
        &self,
        id: i64,
        title: &str,
        bpm: Option<f64>,
        tags: &str,
    ) -> Result<Track, String> {
        let title = sanitize_name(title);
        if let Some(bpm) = bpm {
            if !(20.0..=300.0).contains(&bpm) {
                return Err("bpm outside 20–300".to_string());
            }
        }
        let tags = tags
            .split(',')
            .map(sanitize_name)
            .filter(|tag| tag != "untitled")
            .collect::<Vec<_>>()
            .join(", ");
        let changed = self.conn.execute("UPDATE tracks SET title=?1,bpm=?2,bpm_source=CASE WHEN ?2 IS NULL THEN bpm_source ELSE 'manual' END,tags=?3,updated_at=?4 WHERE id=?5", rusqlite::params![title, bpm, tags, now_secs(), id]).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("track {id} not found"));
        }
        self.get_track(id)?
            .ok_or_else(|| format!("track {id} vanished"))
    }

    pub fn mark_played(&self, id: i64) -> Result<(), String> {
        let changed = self
            .conn
            .execute(
                "UPDATE tracks SET last_played_at=?1 WHERE id=?2",
                rusqlite::params![now_secs(), id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(format!("track {id} not found"));
        }
        Ok(())
    }

    /// Copy selected audio to a user-owned directory. Never overwrite or move a source.
    pub fn export_tracks(&self, ids: &[i64], destination: &Path) -> Result<usize, String> {
        if ids.is_empty() {
            return Err("select at least one loop to export".to_string());
        }
        let destination = destination
            .canonicalize()
            .map_err(|e| format!("cannot use export folder: {e}"))?;
        if !destination.is_dir() {
            return Err("export destination is not a folder".to_string());
        }
        let mut exported = 0;
        for id in ids {
            let track = self
                .get_track(*id)?
                .ok_or_else(|| format!("track {id} not found"))?;
            let source = Path::new(&track.file_path);
            if !source.is_file() {
                return Err(format!("audio for '{}' is missing", track.title));
            }
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("wav");
            let stem = sanitize_name(&track.title);
            let mut target = destination.join(format!("{stem}.{extension}"));
            for suffix in 2..=10_000 {
                if !target.exists() {
                    break;
                }
                target = destination.join(format!("{stem} ({suffix}).{extension}"));
            }
            if target.exists() {
                return Err(format!("too many files named '{stem}' in export folder"));
            }
            std::fs::copy(source, &target)
                .map_err(|e| format!("cannot export '{}': {e}", track.title))?;
            exported += 1;
        }
        Ok(exported)
    }

    fn group_tracks(&self, source_hash: &str) -> Result<Vec<Track>, String> {
        let tracks: Vec<_> = self
            .list_tracks()?
            .into_iter()
            .filter(|track| track.source_hash == source_hash)
            .collect();
        if tracks.is_empty() {
            return Err("looper group not found".to_string());
        }
        Ok(tracks)
    }

    pub fn group_directory(&self, source_hash: &str) -> Result<PathBuf, String> {
        let track = self.group_tracks(source_hash)?.into_iter().next().unwrap();
        let dir = PathBuf::from(track.file_path)
            .parent()
            .ok_or("track has no parent directory")?
            .to_path_buf();
        let root = self
            .root
            .canonicalize()
            .map_err(|e| format!("cannot resolve library root: {e}"))?;
        let canonical = dir
            .canonicalize()
            .map_err(|e| format!("looper folder is missing: {e}"))?;
        if !canonical.starts_with(&root) {
            return Err("looper folder is outside the library".to_string());
        }
        Ok(canonical)
    }

    /// Save one normalized looper cover beside its extracted audio files.
    /// Existing covers are kept so re-imports do not replace a user's choice.
    pub fn save_group_cover(&self, source_hash: &str, bytes: &[u8]) -> Result<bool, String> {
        let normalized = normalize_cover(bytes)?;
        let directory = self.group_directory(source_hash)?;
        let destination = directory.join("cover.jpg");
        if destination.exists() {
            return Ok(false);
        }
        self.atomic_write(&destination, &normalized)?;
        Ok(true)
    }

    /// Return a small local cover as a data URL for the webview UI.
    pub fn group_cover_data_url(&self, source_hash: &str) -> Result<Option<String>, String> {
        const MAX_STORED_COVER_BYTES: u64 = 2 * 1024 * 1024;
        let directory = self.group_directory(source_hash)?;
        let path = directory.join("cover.jpg");
        if !path.is_file() {
            return Ok(None);
        }
        let root = self
            .root
            .canonicalize()
            .map_err(|error| format!("cannot resolve library root: {error}"))?;
        let path = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve cover: {error}"))?;
        if !path.starts_with(root) {
            return Err("cover path escapes the library".to_string());
        }
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_STORED_COVER_BYTES {
            return Err("stored cover exceeds the size limit".to_string());
        }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        use base64::Engine as _;
        Ok(Some(format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }

    /// Move only validated, library-owned files into a temporary directory so
    /// a failed SQLite deletion can restore them without data loss.
    fn quarantine_files(&self, candidates: &[PathBuf]) -> Result<Option<QuarantinedFiles>, String> {
        let root = self
            .root
            .canonicalize()
            .map_err(|error| format!("cannot resolve library root: {error}"))?;
        let mut seen = HashSet::new();
        let mut safe_files = Vec::new();
        for candidate in candidates {
            if !seen.insert(candidate.clone()) {
                continue;
            }
            let metadata = match std::fs::symlink_metadata(candidate) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("cannot inspect library file: {error}")),
            };
            let file_type = metadata.file_type();
            if !file_type.is_file() && !file_type.is_symlink() {
                return Err("refusing to delete a non-file library entry".to_string());
            }
            let parent = candidate
                .parent()
                .ok_or_else(|| "library file has no parent directory".to_string())?
                .canonicalize()
                .map_err(|error| format!("cannot resolve library file parent: {error}"))?;
            if !parent.starts_with(&root) {
                return Err("refusing to delete a file outside the library".to_string());
            }
            safe_files.push(candidate.clone());
        }
        if safe_files.is_empty() {
            return Ok(None);
        }

        let directory = loop {
            let sequence = NEXT_DELETE_QUARANTINE.fetch_add(1, Ordering::Relaxed);
            let candidate = root.join(format!(".olooper-trash-{}-{sequence}", std::process::id()));
            match std::fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("cannot prepare audio deletion: {error}")),
            }
        };
        let mut moved = Vec::with_capacity(safe_files.len());
        for (index, original) in safe_files.into_iter().enumerate() {
            let quarantined = directory.join(format!("asset-{index}"));
            if let Err(error) = std::fs::rename(&original, &quarantined) {
                let files = QuarantinedFiles {
                    directory: directory.clone(),
                    moved,
                };
                let restore_error = self.restore_quarantined(&files).err();
                return Err(match restore_error {
                    Some(restore_error) => format!(
                        "cannot stage library file for deletion: {error}; restore failed: {restore_error}"
                    ),
                    None => format!("cannot stage library file for deletion: {error}"),
                });
            }
            moved.push((original, quarantined));
        }
        Ok(Some(QuarantinedFiles { directory, moved }))
    }

    fn restore_quarantined(&self, files: &QuarantinedFiles) -> Result<(), String> {
        for (original, quarantined) in files.moved.iter().rev() {
            std::fs::rename(quarantined, original)
                .map_err(|error| format!("cannot restore {}: {error}", original.display()))?;
        }
        std::fs::remove_dir(&files.directory).map_err(|error| error.to_string())
    }

    fn purge_quarantined(&self, files: QuarantinedFiles) -> Result<(), String> {
        std::fs::remove_dir_all(&files.directory).map_err(|error| {
            format!(
                "catalog entry was removed but staged audio could not be deleted at {}: {error}",
                files.directory.display()
            )
        })
    }

    /// Rename the derived-audio folder and its catalog label. Source files stay untouched.
    pub fn rename_looper(&self, source_hash: &str, new_name: &str) -> Result<(), String> {
        let tracks = self.group_tracks(source_hash)?;
        if tracks[0].source_type == "custom" {
            return Err("custom loops cannot be renamed as a group".to_string());
        }
        let new_name = sanitize_name(new_name);
        // Validate through the canonical path, but keep the stored lexical path
        // for the filesystem rename and SQL prefix update. On macOS `/var` may
        // canonicalize to `/private/var`, while file_path rows retain `/var`.
        self.group_directory(source_hash)?;
        let old_dir = PathBuf::from(&tracks[0].file_path)
            .parent()
            .ok_or("track has no parent directory")?
            .to_path_buf();
        let new_dir = self.root.join(&new_name);
        if old_dir == new_dir {
            return Ok(());
        }
        if new_dir.exists() {
            return Err("a looper folder with that name already exists".to_string());
        }
        std::fs::rename(&old_dir, &new_dir)
            .map_err(|e| format!("cannot rename looper folder: {e}"))?;
        let old_prefix = old_dir.to_string_lossy();
        let new_prefix = new_dir.to_string_lossy();
        let old_name = &tracks[0].looper_name;
        let result = self.conn.execute(
            "UPDATE tracks SET looper_name=?1,file_path=REPLACE(file_path,?2,?3),\
             title=REPLACE(title,?4,?5),updated_at=?6 WHERE source_hash=?7",
            rusqlite::params![
                new_name,
                old_prefix,
                new_prefix,
                old_name,
                new_name,
                now_secs(),
                source_hash
            ],
        );
        if let Err(error) = result {
            let _ = std::fs::rename(&new_dir, &old_dir);
            return Err(error.to_string());
        }
        Ok(())
    }

    /// Remove a looper's catalog rows, derived audio, and cover. Preserved source
    /// SWF/EXE files live elsewhere and are never included in this deletion.
    pub fn remove_looper(&self, source_hash: &str) -> Result<usize, String> {
        let tracks = self.group_tracks(source_hash)?;
        if tracks[0].source_type == "custom" {
            return Err("custom audio tracks cannot be removed as a looper group".to_string());
        }
        let mut candidates: Vec<PathBuf> = tracks
            .iter()
            .map(|track| PathBuf::from(&track.file_path))
            .collect();
        for track in &tracks {
            if let Some(parent) = Path::new(&track.file_path).parent() {
                candidates.push(parent.join("cover.jpg"));
            }
        }
        let quarantined = self.quarantine_files(&candidates)?;
        let n = match self
            .conn
            .execute("DELETE FROM tracks WHERE source_hash=?1", [source_hash])
        {
            Ok(n) => n,
            Err(error) => {
                if let Some(quarantined) = &quarantined {
                    self.restore_quarantined(quarantined)?;
                }
                return Err(error.to_string());
            }
        };
        if n == 0 {
            if let Some(quarantined) = &quarantined {
                self.restore_quarantined(quarantined)?;
            }
            return Err("looper group not found".to_string());
        }
        if let Some(quarantined) = quarantined {
            self.purge_quarantined(quarantined)?;
        }
        Ok(n)
    }

    // --- Audio-file CUEs ---

    fn get_legacy_loop_slots(&self, track_id: i64) -> Result<Vec<LoopSlot>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,track_id,slot,label,cue_ms,loop_start_ms,loop_end_ms,enabled \
                 FROM loop_slots WHERE track_id=?1 ORDER BY slot",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([track_id], |r| {
                Ok(LoopSlot {
                    id: r.get(0)?,
                    track_id: r.get(1)?,
                    slot: r.get(2)?,
                    label: r.get(3)?,
                    cue_ms: r.get(4)?,
                    loop_start_ms: r.get(5)?,
                    loop_end_ms: r.get(6)?,
                    enabled: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    fn audio_path_for_track(&self, track_id: i64) -> Result<(Track, PathBuf), String> {
        let track = self
            .get_track(track_id)?
            .ok_or_else(|| format!("track {track_id} not found"))?;
        let path = self.confine(Path::new(&track.file_path))?;
        let canonical_path = path
            .canonicalize()
            .map_err(|error| format!("cannot resolve library audio file: {error}"))?;
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|error| format!("cannot resolve library root: {error}"))?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("CUE and loop metadata is confined to library-managed audio".to_string());
        }
        Ok((track, canonical_path))
    }

    /// Read markers from the audio file on every track open. For pre-file-tag
    /// libraries, migrate old SQLite slots to the file once, then discard them.
    pub fn get_serato_metadata(&self, track_id: i64) -> Result<SeratoMetadata, String> {
        let (track, path) = self.audio_path_for_track(track_id)?;
        let mut read = serato::read_audio_file(&path)?;
        let legacy_slots = self.get_legacy_loop_slots(track_id)?;
        if !read.markers_present && !legacy_slots.is_empty() {
            let mut migrated = SeratoMetadata {
                bpm: read.metadata.bpm.or(track.bpm),
                ..SeratoMetadata::default()
            };
            for old in legacy_slots.iter().filter(|slot| slot.enabled) {
                if (0..=track.duration_ms).contains(&old.cue_ms) {
                    migrated.cues.push(SeratoCue {
                        slot: old.slot,
                        label: old.label.clone(),
                        position_ms: old.cue_ms,
                    });
                }
            }
            serato::write_audio_file(&path, &migrated, track.duration_ms)?;
            self.clear_legacy_loop_slots(track_id)?;
            read = serato::read_audio_file(&path)?;
        } else if read.markers_present && !legacy_slots.is_empty() {
            // Audio tags win over stale private database copies.
            self.clear_legacy_loop_slots(track_id)?;
        }

        if read.needs_wave_id3_normalization {
            // Migrate SQLite slots first: normalizing an empty ID3 chunk writes
            // default markers, which would otherwise hide legacy CUEs.
            serato::write_audio_file(&path, &read.metadata, track.duration_ms)?;
            read = serato::read_audio_file(&path)?;
        }

        read.metadata
            .cues
            .retain(|cue| (0..=track.duration_ms).contains(&cue.position_ms));
        read.metadata.loops.retain(|saved| {
            saved.start_ms >= 0
                && saved.end_ms > saved.start_ms
                && saved.end_ms <= track.duration_ms
                && saved.end_ms <= 0x00ff_ffff
        });
        let defaults_added = ensure_default_serato_cue(&mut read.metadata);
        if defaults_added {
            serato::write_audio_file(&path, &read.metadata, track.duration_ms)?;
            read = serato::read_audio_file(&path)?;
        }
        if let Some(bpm) = read.metadata.bpm {
            if track.bpm != Some(bpm) {
                self.conn
                    .execute(
                        "UPDATE tracks SET bpm=?1,bpm_confidence=NULL,bpm_source='serato',updated_at=?2 WHERE id=?3",
                        rusqlite::params![bpm, now_secs(), track_id],
                    )
                    .map_err(|error| format!("cannot update BPM from audio tags: {error}"))?;
            }
        } else {
            read.metadata.bpm = track.bpm;
        }
        Ok(read.metadata)
    }

    fn clear_legacy_loop_slots(&self, track_id: i64) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM loop_slots WHERE track_id=?1", [track_id])
            .map_err(|error| format!("cannot clear migrated CUE database rows: {error}"))?;
        Ok(())
    }

    fn save_serato_metadata(
        &self,
        track_id: i64,
        mut metadata: SeratoMetadata,
    ) -> Result<SeratoMetadata, String> {
        let (track, path) = self.audio_path_for_track(track_id)?;
        if metadata.bpm.is_none() {
            metadata.bpm = track.bpm;
        }
        serato::write_audio_file(&path, &metadata, track.duration_ms)?;
        self.clear_legacy_loop_slots(track_id)?;
        Ok(serato::read_audio_file(&path)?.metadata)
    }

    pub fn set_serato_cue(
        &self,
        track_id: i64,
        slot: i64,
        position_ms: Option<i64>,
    ) -> Result<SeratoMetadata, String> {
        if !(1..=4).contains(&slot) {
            return Err("CUE slot must be between 1 and 4".to_string());
        }
        let mut metadata = self.get_serato_metadata(track_id)?;
        metadata.cues.retain(|cue| cue.slot != slot);
        let position_ms = if slot == 1 { Some(0) } else { position_ms };
        if let Some(position_ms) = position_ms {
            let duration = self
                .get_track(track_id)?
                .ok_or_else(|| format!("track {track_id} not found"))?
                .duration_ms;
            if !(0..=duration).contains(&position_ms) {
                return Err("CUE position is outside the track".to_string());
            }
            metadata.cues.push(SeratoCue {
                slot,
                label: cue_label_for_slot(slot),
                position_ms,
            });
            metadata.cues.sort_by_key(|cue| cue.slot);
        }
        self.save_serato_metadata(track_id, metadata)
    }

    pub fn sync_serato_metadata(&self, track_id: i64) -> Result<(), String> {
        let metadata = self.get_serato_metadata(track_id)?;
        let (_, path) = self.audio_path_for_track(track_id)?;
        let duration = self
            .get_track(track_id)?
            .ok_or_else(|| format!("track {track_id} not found"))?
            .duration_ms;
        serato::write_audio_file(&path, &metadata, duration)
    }

    /// Ensure `path` resolves inside the library root (after canonicalize).
    fn confine(&self, path: &Path) -> Result<PathBuf, String> {
        let root = self
            .root
            .canonicalize()
            .map_err(|e| format!("cannot resolve library root: {e}"))?;
        // The file may not exist yet (tmp name): canonicalize its parent.
        let parent = path.parent().ok_or("bad destination path")?;
        let canon_parent = parent
            .canonicalize()
            .map_err(|e| format!("cannot resolve destination: {e}"))?;
        if !canon_parent.starts_with(&root) {
            return Err("destination escapes the library".to_string());
        }
        Ok(canon_parent.join(path.file_name().ok_or("bad file name")?))
    }

    /// Write frames atomically: tmp in same dir → validate → rename.
    /// Returns the final path. Cleans the tmp file on any failure.
    fn atomic_write(&self, dest: &Path, frames: &[u8]) -> Result<PathBuf, String> {
        let dest = self.confine(dest)?;
        let parent = dest.parent().ok_or("bad destination path")?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| format!("cannot create temporary audio: {e}"))?;
        use std::io::{Read, Seek, SeekFrom, Write};
        tmp.write_all(frames)
            .and_then(|_| tmp.as_file_mut().sync_all())
            .and_then(|_| tmp.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|e| format!("write failed: {e}"))?;
        let mut back = Vec::new();
        tmp.read_to_end(&mut back)
            .map_err(|e| format!("verify failed: {e}"))?;
        if back != frames {
            return Err("verify failed: bytes differ".to_string());
        }
        tmp.persist(&dest)
            .map_err(|e| format!("rename failed: {e}"))?;
        Ok(dest)
    }

    /// Persist extracted sounds: files under `<looper>/` + rows.
    /// Idempotent on `(source_hash, source_sound_id)`.
    ///
    /// Audio decode + BPM analysis run in bounded parallel batches; file writes
    /// and SQLite operations remain ordered on the import worker.
    #[allow(clippy::too_many_arguments)]
    pub fn import_sounds(
        &self,
        looper: &str,
        source_type: &str,
        source_path: &str,
        source_hash: &str,
        exe_offset: Option<i64>,
        exe_length: Option<i64>,
        sounds: &[Sound],
    ) -> Result<ImportReport, String> {
        self.import_sounds_with_progress(
            looper,
            source_type,
            source_path,
            source_hash,
            exe_offset,
            exe_length,
            sounds,
            |_, _, _| Ok(()),
        )
        .map_err(|(_, e)| e)
    }

    /// Encode a `LoopBuffer` as a minimal PCM16 WAV byte vector.
    fn loop_buffer_to_wav(buf: &crate::player::LoopBuffer) -> Vec<u8> {
        let channels = buf.channels as u32;
        let rate = buf.rate;
        let byte_align = channels * 2;
        let byte_rate = rate * byte_align;
        let data_bytes = (buf.samples.len() * 2) as u32;
        let mut wav = Vec::with_capacity(44 + buf.samples.len() * 2);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&(channels as u16).to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&(byte_align as u16).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        for s in &buf.samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        wav
    }

    /// Decode MP3 bytes, trim to `[seek_samples, seek_samples + sample_count)`,
    /// and return the trimmed `LoopBuffer` plus its WAV byte encoding.
    /// Returns `None` when seek_samples and sample_count are both zero (no trim
    /// needed) or when the declared range is invalid.
    fn trim_mp3_gapless(
        buf: &crate::player::LoopBuffer,
        seek_samples: u16,
        sample_count: u32,
    ) -> Option<(crate::player::LoopBuffer, Vec<u8>)> {
        if seek_samples == 0 && sample_count == 0 {
            return None;
        }
        let total = buf.frames();
        let channels = buf.channels as usize;
        let start = seek_samples as usize;
        let end = if sample_count > 0 {
            (start + sample_count as usize).min(total)
        } else {
            total
        };
        if start >= total || end <= start {
            return None;
        }
        let start_sample = start * channels;
        let end_sample = end * channels;
        let trimmed = crate::player::LoopBuffer {
            samples: buf.samples[start_sample..end_sample].to_vec(),
            channels: buf.channels,
            rate: buf.rate,
        };
        let wav = Self::loop_buffer_to_wav(&trimmed);
        Some((trimmed, wav))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn import_sounds_with_progress<F>(
        &self,
        looper: &str,
        source_type: &str,
        source_path: &str,
        source_hash: &str,
        exe_offset: Option<i64>,
        exe_length: Option<i64>,
        sounds: &[Sound],
        progress: F,
    ) -> Result<ImportReport, (ImportReport, String)>
    where
        F: FnMut(&str, usize, usize) -> Result<(), String>,
    {
        self.import_sounds_with_cover_and_progress(
            looper,
            source_type,
            source_path,
            source_hash,
            exe_offset,
            exe_length,
            sounds,
            None,
            progress,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn import_sounds_with_cover_and_progress<F>(
        &self,
        looper: &str,
        source_type: &str,
        source_path: &str,
        source_hash: &str,
        exe_offset: Option<i64>,
        exe_length: Option<i64>,
        sounds: &[Sound],
        cover_image: Option<&[u8]>,
        mut progress: F,
    ) -> Result<ImportReport, (ImportReport, String)>
    where
        F: FnMut(&str, usize, usize) -> Result<(), String>,
    {
        if sounds.is_empty() {
            return Err((
                ImportReport {
                    looper: looper.to_string(),
                    added: 0,
                    already_there: 0,
                    failed: vec![],
                    track_ids: vec![],
                },
                "no extractable sounds".to_string(),
            ));
        }
        let (artist_tag, album_tag) = looper_audio_tags(looper);
        let looper = sanitize_name(looper);
        let dir = self.root.join(&looper);
        std::fs::create_dir_all(&dir).map_err(|e| {
            let partial = ImportReport {
                looper: looper.clone(),
                added: 0,
                already_there: 0,
                failed: vec![],
                track_ids: vec![],
            };
            (partial, format!("cannot create looper dir: {e}"))
        })?;

        let mut added = 0;
        let mut already_there = 0;
        let mut failed = Vec::new();
        let mut track_ids = Vec::new();
        let make_partial = |looper: &str,
                            added: usize,
                            already_there: usize,
                            failed: Vec<FailedSound>,
                            track_ids: Vec<i64>| {
            ImportReport {
                looper: looper.to_string(),
                added,
                already_there,
                failed,
                track_ids,
            }
        };
        let total = sounds.len();
        let workers = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(2)
            .clamp(1, 4);

        // Decode and BPM-analyze small bounded batches in parallel. Keep all
        // SQLite writes and atomic file copies on this worker thread and commit
        // each batch in original SWF sound order.
        for batch_start in (0..total).step_by(workers) {
            let batch_end = (batch_start + workers).min(total);
            let batch_len = batch_end - batch_start;
            let mut known_ids = vec![None; batch_len];
            let mut prepared: Vec<Option<Result<PreparedSound, String>>> =
                std::iter::repeat_with(|| None).take(batch_len).collect();
            let mut decode_indices = Vec::new();

            for (slot, index) in (batch_start..batch_end).enumerate() {
                let sound = &sounds[index];
                let known: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=?2",
                        rusqlite::params![source_hash, sound.id as i64],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| {
                        (
                            make_partial(
                                &looper,
                                added,
                                already_there,
                                failed.clone(),
                                track_ids.clone(),
                            ),
                            error.to_string(),
                        )
                    })?;
                if let Some(id) = known {
                    known_ids[slot] = Some(id);
                } else if sound.frames.is_empty() {
                    prepared[slot] = Some(Err("unsupported or empty sound".to_string()));
                } else {
                    progress("extracting", index + 1, total).map_err(|error| {
                        (
                            make_partial(
                                &looper,
                                added,
                                already_there,
                                failed.clone(),
                                track_ids.clone(),
                            ),
                            error,
                        )
                    })?;
                    decode_indices.push((slot, index));
                }
            }

            let decoded_batch = std::thread::scope(|scope| {
                let handles: Vec<_> = decode_indices
                    .iter()
                    .map(|(slot, index)| {
                        let sound = &sounds[*index];
                        let slot = *slot;
                        (slot, scope.spawn(move || prepare_sound(sound)))
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|(slot, handle)| {
                        let result = handle
                            .join()
                            .unwrap_or_else(|_| Err("audio decode worker panicked".to_string()));
                        (slot, result)
                    })
                    .collect::<Vec<_>>()
            });
            for (slot, result) in decoded_batch {
                prepared[slot] = Some(result);
            }

            for (slot, index) in (batch_start..batch_end).enumerate() {
                let sound = &sounds[index];
                if let Some(id) = known_ids[slot] {
                    already_there += 1;
                    track_ids.push(id);
                    continue;
                }
                let item = match prepared[slot]
                    .take()
                    .unwrap_or_else(|| Err("audio was not prepared".to_string()))
                {
                    Ok(item) => item,
                    Err(reason) => {
                        failed.push(FailedSound {
                            id: sound.id as i64,
                            reason,
                        });
                        continue;
                    }
                };
                let current = index + 1;
                progress("adjusting BPM", current, total).map_err(|error| {
                    (
                        make_partial(
                            &looper,
                            added,
                            already_there,
                            failed.clone(),
                            track_ids.clone(),
                        ),
                        error,
                    )
                })?;
                progress("adjusting loops", current, total).map_err(|error| {
                    (
                        make_partial(
                            &looper,
                            added,
                            already_there,
                            failed.clone(),
                            track_ids.clone(),
                        ),
                        error,
                    )
                })?;
                let dest = dir.join(format!("{:02}_{}.{}", index + 1, sound.id, item.file_codec));
                let final_path = self
                    .atomic_write(&dest, &item.file_bytes)
                    .map_err(|error| {
                        (
                            make_partial(
                                &looper,
                                added,
                                already_there,
                                failed.clone(),
                                track_ids.clone(),
                            ),
                            error,
                        )
                    })?;
                if let Err(reason) = serato::write_extracted_audio_tags(
                    &final_path,
                    artist_tag.as_deref(),
                    &album_tag,
                    cover_image,
                ) {
                    let _ = std::fs::remove_file(&final_path);
                    failed.push(FailedSound {
                        id: sound.id as i64,
                        reason,
                    });
                    continue;
                }
                let title = format!("{:02} · {}", index + 1, looper);
                progress("inserting in library", current, total).map_err(|error| {
                    (
                        make_partial(
                            &looper,
                            added,
                            already_there,
                            failed.clone(),
                            track_ids.clone(),
                        ),
                        error,
                    )
                })?;
                match self.add_track(
                    &title,
                    &looper,
                    &final_path,
                    source_type,
                    source_path,
                    source_hash,
                    sound.id as i64,
                    exe_offset,
                    exe_length,
                    &item.file_codec,
                    &item.buffer,
                    0,
                    0,
                ) {
                    Ok((id, true)) => {
                        if let Some(estimate) = item.estimate {
                            self.update_bpm(id, estimate.bpm, Some(estimate.confidence), false)
                                .map_err(|error| {
                                    (
                                        make_partial(
                                            &looper,
                                            added,
                                            already_there,
                                            failed.clone(),
                                            track_ids.clone(),
                                        ),
                                        error,
                                    )
                                })?;
                        }
                        added += 1;
                        track_ids.push(id);
                    }
                    Ok((id, false)) => {
                        let _ = std::fs::remove_file(&final_path);
                        already_there += 1;
                        track_ids.push(id);
                    }
                    Err(error) => {
                        let _ = std::fs::remove_file(&final_path);
                        return Err((
                            make_partial(&looper, added, already_there, failed, track_ids),
                            error,
                        ));
                    }
                }
            }
        }
        if added == 0 && already_there == 0 {
            let _ = std::fs::remove_dir(&dir); // don't leave empty dirs
            return Err((
                make_partial(&looper, 0, 0, failed, track_ids),
                "no sounds could be imported".to_string(),
            ));
        }
        Ok(ImportReport {
            looper,
            added,
            already_there,
            failed,
            track_ids,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomReport {
    pub file: String,
    pub added: bool,
    pub track_id: Option<i64>,
    pub bpm: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablistImportCount {
    pub source_path: String,
    pub tracks: usize,
}

impl Library {
    /// Import user audio files: validate → copy into `Custom Loops/` →
    /// BPM estimate → row. Per-file results; never touches originals.
    pub fn import_custom(&self, paths: &[String]) -> Vec<CustomReport> {
        paths.iter().map(|p| self.import_one_custom(p)).collect()
    }

    /// Import one user audio file: validate → copy into `Custom Loops/` →
    /// BPM estimate → row. Never touches the original. Public so the
    /// background import worker can report progress per file.
    pub fn import_one_custom(&self, path: &str) -> CustomReport {
        let fail = |reason: String| CustomReport {
            file: path.to_string(),
            added: false,
            track_id: None,
            bpm: None,
            bpm_confidence: None,
            error: Some(reason),
        };
        let src = Path::new(path);
        let data = match std::fs::metadata(src)
            .map_err(|e| format!("cannot open file: {e}"))
            .and_then(|m| {
                if m.len() > 512 * 1024 * 1024 {
                    Err("file exceeds the 512 MiB limit".to_string())
                } else {
                    std::fs::read(src).map_err(|e| format!("cannot read file: {e}"))
                }
            }) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        // Decode validates the container; the buffer also feeds BPM + row metadata.
        let buf = match crate::player::decode_bytes(&data) {
            Ok(b) => b,
            Err(e) => return fail(e),
        };
        let hash = sha256_hex(&data);
        if let Ok(Some(id)) = self
            .conn
            .query_row(
                "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=0",
                rusqlite::params![hash],
                |r| r.get(0),
            )
            .optional()
        {
            return CustomReport {
                file: path.to_string(),
                added: false,
                track_id: Some(id),
                bpm: None,
                bpm_confidence: None,
                error: Some("already in library".to_string()),
            };
        }
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("loop");
        let ext = src
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("wav")
            .to_lowercase();
        let codec = ext.clone();
        let dir = self.root.join("Custom Loops");
        let mut dest = dir.join(format!("{}.{}", sanitize_name(stem), ext));
        // Collision-safe: never overwrite a different file.
        let mut n = 2;
        while dest.exists() {
            dest = dir.join(format!("{} ({}).{}", sanitize_name(stem), n, ext));
            n += 1;
        }
        let final_path = match self.atomic_write(&dest, &data) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let estimate = crate::analysis::estimate(&buf);
        let title = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("loop")
            .to_string();
        match self.add_track(
            &title,
            "Custom Loops",
            &final_path,
            "custom",
            path,
            &hash,
            0,
            None,
            None,
            &codec,
            &buf,
            0,
            0,
        ) {
            Ok((id, true)) => {
                if let Some(e) = &estimate {
                    let _ = self.update_bpm(id, e.bpm, Some(e.confidence), false);
                }
                CustomReport {
                    file: path.to_string(),
                    added: true,
                    track_id: Some(id),
                    bpm: estimate.as_ref().map(|e| e.bpm),
                    bpm_confidence: estimate.as_ref().map(|e| e.confidence),
                    error: None,
                }
            }
            Ok((id, false)) => {
                let _ = std::fs::remove_file(&final_path);
                CustomReport {
                    file: path.to_string(),
                    added: false,
                    track_id: Some(id),
                    bpm: None,
                    bpm_confidence: None,
                    error: Some("already in library".to_string()),
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(&final_path);
                fail(e)
            }
        }
    }

    /// Persist one pre-looped Tablist audio file under its looper group.
    /// The whole audio file remains the loop region; published BPM is retained.
    pub fn import_tablist_track(
        &self,
        looper_name: &str,
        source_hash: &str,
        source_url: &str,
        remote_id: &str,
        title: &str,
        extension: &str,
        data: &[u8],
        bpm: Option<f64>,
    ) -> CustomReport {
        let fail = |reason: String| CustomReport {
            file: title.to_string(),
            added: false,
            track_id: None,
            bpm,
            bpm_confidence: None,
            error: Some(reason),
        };
        if data.is_empty() || data.len() > 512 * 1024 * 1024 {
            return fail("Tablist audio is empty or exceeds the 512 MiB limit".to_string());
        }
        let extension = extension.to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "wav" | "mp3" | "ogg" | "flac" | "m4a" | "aac" | "audio"
        ) {
            return fail("Tablist returned an unsupported audio format".to_string());
        }
        let buf = match crate::player::decode_bytes(data) {
            Ok(buffer) => buffer,
            Err(error) => return fail(format!("'{}' is not playable audio: {error}", title)),
        };
        let remote_hash = Sha256::digest(remote_id.as_bytes());
        let mut sound_id =
            (u64::from_be_bytes(remote_hash[..8].try_into().unwrap()) & i64::MAX as u64) as i64;
        if sound_id == 0 {
            sound_id = 1;
        }
        let existing: Result<Option<i64>, _> = self
            .conn
            .query_row(
                "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=?2",
                rusqlite::params![source_hash, sound_id],
                |row| row.get(0),
            )
            .optional();
        match existing {
            Ok(Some(id)) => {
                return CustomReport {
                    file: title.to_string(),
                    added: false,
                    track_id: Some(id),
                    bpm,
                    bpm_confidence: None,
                    error: Some("already in library".to_string()),
                }
            }
            Ok(None) => {}
            Err(error) => return fail(error.to_string()),
        }

        let requested_name = sanitize_name(looper_name);
        let known_group: Result<Option<String>, _> = self
            .conn
            .query_row(
                "SELECT looper_name FROM tracks WHERE source_hash=?1 LIMIT 1",
                [source_hash],
                |row| row.get(0),
            )
            .optional();
        let is_new_group = known_group.as_ref().is_ok_and(|group| group.is_none());
        let mut looper_name = match known_group {
            Ok(Some(name)) => name,
            Ok(None) => requested_name.clone(),
            Err(error) => return fail(error.to_string()),
        };
        if is_new_group {
            let mut suffix = 2;
            loop {
                let directory = self.root.join(&looper_name);
                let owner: Result<Option<String>, _> = self
                    .conn
                    .query_row(
                        "SELECT source_hash FROM tracks WHERE looper_name=?1 LIMIT 1",
                        [&looper_name],
                        |row| row.get(0),
                    )
                    .optional();
                match owner {
                    Ok(Some(hash)) if hash == source_hash => break,
                    Ok(None) if !directory.exists() => break,
                    Ok(Some(_)) | Ok(None) => {
                        looper_name = format!("{} ({suffix})", requested_name);
                        suffix += 1;
                        if suffix > 10_000 {
                            return fail("too many Tablist looper name collisions".to_string());
                        }
                    }
                    Err(error) => return fail(error.to_string()),
                }
            }
        }
        let title = sanitize_name(title);
        let directory = self.root.join(&looper_name);
        if let Err(error) = std::fs::create_dir_all(&directory) {
            return fail(format!("cannot create Tablist looper folder: {error}"));
        }
        let mut destination = directory.join(format!("{title}.{extension}"));
        let mut suffix = 2;
        while destination.exists() {
            destination = directory.join(format!("{title} ({suffix}).{extension}"));
            suffix += 1;
        }
        let final_path = match self.atomic_write(&destination, data) {
            Ok(path) => path,
            Err(error) => return fail(error),
        };
        let (id, added) = match self.add_track(
            &title,
            &looper_name,
            &final_path,
            "tablist",
            source_url,
            source_hash,
            sound_id,
            None,
            None,
            &extension,
            &buf,
            0,
            0,
        ) {
            Ok(result) => result,
            Err(error) => {
                let _ = std::fs::remove_file(&final_path);
                return fail(error);
            }
        };
        if !added {
            let _ = std::fs::remove_file(&final_path);
            return CustomReport {
                file: title,
                added: false,
                track_id: Some(id),
                bpm,
                bpm_confidence: None,
                error: Some("already in library".to_string()),
            };
        }
        let estimate = crate::analysis::estimate(&buf);
        let (effective_bpm, confidence) = match bpm {
            Some(bpm) => (Some(bpm), None),
            None => (
                estimate.as_ref().map(|estimate| estimate.bpm),
                estimate.as_ref().map(|estimate| estimate.confidence),
            ),
        };
        if let Some(bpm) = effective_bpm {
            if let Err(error) = self.update_bpm(id, bpm, confidence, false) {
                return fail(error);
            }
        }
        CustomReport {
            file: title,
            added: true,
            track_id: Some(id),
            bpm: effective_bpm,
            bpm_confidence: confidence,
            error: None,
        }
    }
}

struct PreparedSound {
    buffer: crate::player::LoopBuffer,
    file_bytes: Vec<u8>,
    file_codec: String,
    estimate: Option<crate::analysis::BpmEstimate>,
}

fn prepare_sound(sound: &Sound) -> Result<PreparedSound, String> {
    let buffer = crate::player::decode_bytes(&sound.frames)?;
    let (buffer, file_bytes, file_codec) =
        if sound.codec == "mp3" && (sound.seek_samples > 0 || sound.sample_count > 0) {
            if let Some((trimmed, wav)) =
                Library::trim_mp3_gapless(&buffer, sound.seek_samples, sound.sample_count)
            {
                (trimmed, wav, "wav".to_string())
            } else {
                (buffer, sound.frames.clone(), sound.codec.clone())
            }
        } else {
            (buffer, sound.frames.clone(), sound.codec.clone())
        };
    let estimate = crate::analysis::estimate(&buffer);
    Ok(PreparedSound {
        buffer,
        file_bytes,
        file_codec,
        estimate,
    })
}

const MAX_COVER_INPUT_BYTES: usize = 10 * 1024 * 1024;

fn normalize_cover(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_COVER_INPUT_BYTES {
        return Err("cover is empty or exceeds the 10 MiB limit".to_string());
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("cannot detect cover image format: {error}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|error| format!("cannot decode cover image: {error}"))?;
    let thumbnail = image.thumbnail(512, 512);
    let mut normalized = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut normalized, 84)
        .encode_image(&thumbnail)
        .map_err(|error| format!("cannot encode cover thumbnail: {error}"))?;
    Ok(normalized)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let v: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if v > SCHEMA_VERSION {
        return Err(format!(
            "database schema v{v} is newer than supported v{SCHEMA_VERSION}"
        ));
    }
    if v == 0 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE tracks(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               title TEXT NOT NULL,
               file_path TEXT NOT NULL,
               source_type TEXT NOT NULL,
               source_path TEXT NOT NULL,
               source_hash TEXT NOT NULL,
               source_sound_id INTEGER NOT NULL DEFAULT 0,
               exe_offset INTEGER,
               exe_length INTEGER,
               codec TEXT NOT NULL,
               sample_rate INTEGER,
               channels INTEGER,
               duration_ms INTEGER NOT NULL,
               seek_samples INTEGER NOT NULL DEFAULT 0,
               trimmed_leading INTEGER NOT NULL DEFAULT 0,
               bpm REAL,
               bpm_confidence REAL,
               bpm_source TEXT,
               primary_cue_ms INTEGER NOT NULL DEFAULT 0,
               loop_start_ms INTEGER NOT NULL DEFAULT 0,
               loop_end_ms INTEGER NOT NULL DEFAULT 0,
               loop_enabled INTEGER NOT NULL DEFAULT 1,
               imported_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               UNIQUE(source_hash, source_sound_id));
             CREATE INDEX idx_tracks_path ON tracks(file_path);
             PRAGMA user_version = 1;
             COMMIT;",
        )
        .map_err(|e| format!("migration 0→1 failed: {e}"))?;
    }
    if v < 2 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS loop_slots(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
               slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 4),
               label TEXT NOT NULL DEFAULT 'A',
               cue_ms INTEGER NOT NULL DEFAULT 0,
               loop_start_ms INTEGER NOT NULL DEFAULT 0,
               loop_end_ms INTEGER NOT NULL DEFAULT 0,
               enabled INTEGER NOT NULL DEFAULT 0,
               UNIQUE(track_id, slot));
             PRAGMA user_version = 2;
             COMMIT;",
        )
        .map_err(|e| format!("migration 1→2 failed: {e}"))?;
    }
    if v < 3 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tracks ADD COLUMN looper_name TEXT NOT NULL DEFAULT 'Imported Looper';
             PRAGMA user_version = 3;
             COMMIT;",
        )
        .map_err(|e| format!("migration 2→3 failed: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT id,source_type,source_path FROM tracks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let rows = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (id, source_type, source_path) in rows {
            let name = if source_type == "custom" {
                "Custom Loops".to_string()
            } else {
                Path::new(&source_path)
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .map(sanitize_name)
                    .unwrap_or_else(|| "Imported Looper".to_string())
            };
            conn.execute(
                "UPDATE tracks SET looper_name=?1 WHERE id=?2",
                rusqlite::params![name, id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if v < 4 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tracks ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 4;
             COMMIT;",
        )
        .map_err(|e| format!("migration 3→4 failed: {e}"))?;
    }
    if v < 5 {
        conn.execute_batch("BEGIN; ALTER TABLE tracks ADD COLUMN tags TEXT NOT NULL DEFAULT ''; ALTER TABLE tracks ADD COLUMN last_played_at INTEGER; PRAGMA user_version = 5; COMMIT;")
            .map_err(|e| format!("migration 4→5 failed: {e}"))?;
    }
    if v < 6 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tracks ADD COLUMN loop_start_frame INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tracks ADD COLUMN loop_end_frame INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tracks ADD COLUMN loop_origin TEXT NOT NULL DEFAULT 'manual';
             ALTER TABLE tracks ADD COLUMN loop_quality REAL NOT NULL DEFAULT 1.0;
             ALTER TABLE tracks ADD COLUMN loop_needs_review INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tracks ADD COLUMN total_frames INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 6;
             COMMIT;",
        )
        .map_err(|e| format!("migration 5→6 failed: {e}"))?;
        // Backfill total_frames from duration_ms and sample_rate for existing rows.
        conn.execute_batch(
            "UPDATE tracks SET total_frames = duration_ms * sample_rate / 1000 WHERE total_frames = 0;",
        )
        .map_err(|e| format!("migration 5→6 backfill failed: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
