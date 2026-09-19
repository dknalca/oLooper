//! Persistent library: SQLite catalog + audio as normal files.
//!
//! The database is metadata only. Every write path keeps `Loopers/` and
//! `Custom Loops/` human-browsable; file copies go `tmp → validate → rename`
//! and row writes are transactional. Removing a track deletes its row, never
//! the user's audio.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::import::swf::Sound;

/// Current schema version (`PRAGMA user_version`).
const SCHEMA_VERSION: i32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: i64,
    pub title: String,
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
    pub bpm: Option<f64>,
    pub bpm_confidence: Option<f64>,
    pub bpm_source: Option<String>,
    pub primary_cue_ms: i64,
    pub loop_start_ms: i64,
    pub loop_end_ms: i64,
    pub loop_enabled: bool,
    pub imported_at: i64,
    pub updated_at: i64,
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

pub fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// Strip path separators, `..`, control chars; cap length. Never empty.
pub fn sanitize_name(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')') {
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

pub struct Library {
    conn: Connection,
    pub root: PathBuf,
}

impl Library {
    /// Open (creating) `root/olooper.db`, making library dirs, migrating.
    /// One transaction per migration step; version set only on success.
    pub fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root.join("Loopers"))
            .and_then(|()| std::fs::create_dir_all(root.join("Custom Loops")))
            .map_err(|e| format!("cannot create library dirs: {e}"))?;
        let conn = Connection::open(root.join("olooper.db"))
            .map_err(|e| format!("cannot open library database: {e}"))?;
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
                "SELECT id,title,file_path,source_type,source_path,source_hash,\
                 source_sound_id,codec,sample_rate,channels,duration_ms,\
                 bpm,bpm_confidence,bpm_source,primary_cue_ms,loop_start_ms,\
                 loop_end_ms,loop_enabled,imported_at,updated_at \
                 FROM tracks ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let file_path: String = r.get(2)?;
                Ok(Track {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    file_path: file_path.clone(),
                    exists: Path::new(&file_path).is_file(),
                    source_type: r.get(3)?,
                    source_path: r.get(4)?,
                    source_hash: r.get(5)?,
                    source_sound_id: r.get(6)?,
                    codec: r.get(7)?,
                    sample_rate: r.get(8)?,
                    channels: r.get(9)?,
                    duration_ms: r.get(10)?,
                    bpm: r.get(11)?,
                    bpm_confidence: r.get(12)?,
                    bpm_source: r.get(13)?,
                    primary_cue_ms: r.get(14)?,
                    loop_start_ms: r.get(15)?,
                    loop_end_ms: r.get(16)?,
                    loop_enabled: r.get(17)?,
                    imported_at: r.get(18)?,
                    updated_at: r.get(19)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_track(&self, id: i64) -> Result<Option<Track>, String> {
        Ok(self.list_tracks()?.into_iter().find(|t| t.id == id))
    }

    /// Insert or return the existing row id on `(source_hash, source_sound_id)`.
    #[allow(clippy::too_many_arguments)]
    pub fn add_track(
        &self,
        title: &str,
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
        let n = self
            .conn
            .execute(
                "INSERT INTO tracks(\
                 title,file_path,source_type,source_path,source_hash,source_sound_id,\
                 exe_offset,exe_length,codec,sample_rate,channels,duration_ms,\
                 seek_samples,trimmed_leading,\
                 primary_cue_ms,loop_start_ms,loop_end_ms,loop_enabled,\
                 imported_at,updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,\
                 0,0,?12,1,?15,?15) \
                 ON CONFLICT(source_hash,source_sound_id) DO NOTHING",
                rusqlite::params![
                    title,
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
        self.conn
            .execute(
                "UPDATE tracks SET primary_cue_ms=?1,loop_start_ms=?2,loop_end_ms=?3,\
                 loop_enabled=?4,updated_at=?5 WHERE id=?6",
                rusqlite::params![cue_ms, start_ms, end_ms, enabled, now_secs(), id],
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

    /// Deletes the row only. Audio files are never touched.
    pub fn remove_track(&self, id: i64) -> Result<bool, String> {
        let n = self
            .conn
            .execute("DELETE FROM tracks WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(n == 1)
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
        let tmp = dest.with_extension("mp3.tmp");
        let out = (|| -> Result<PathBuf, String> {
            std::fs::write(&tmp, frames).map_err(|e| format!("write failed: {e}"))?;
            let back = std::fs::read(&tmp).map_err(|e| format!("verify failed: {e}"))?;
            if back != frames {
                return Err("verify failed: bytes differ".to_string());
            }
            std::fs::rename(&tmp, &dest).map_err(|e| format!("rename failed: {e}"))?;
            Ok(dest)
        })();
        if out.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        out
    }

    /// Persist extracted sounds: files under `Loopers/<looper>/` + rows.
    /// Idempotent on `(source_hash, source_sound_id)`.
    ///
    /// Note: every sound is fully decoded for duration/rate metadata, so
    /// importing a ~50-sound looper takes minutes in debug builds
    /// (release is several times faster). A header-only duration scan is
    /// future work, not MVP.
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
        if sounds.is_empty() {
            return Err("no extractable sounds".to_string());
        }
        let looper = sanitize_name(looper);
        let dir = self.root.join("Loopers").join(&looper);
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create looper dir: {e}"))?;

        let mut added = 0;
        let mut already_there = 0;
        let mut failed = Vec::new();
        let mut track_ids = Vec::new();
        for (i, s) in sounds.iter().enumerate() {
            // Skip known rows before touching the filesystem.
            let known: Option<i64> = self
                .conn
                .query_row(
                    "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=?2",
                    rusqlite::params![source_hash, s.id as i64],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(id) = known {
                already_there += 1;
                track_ids.push(id);
                continue;
            }
            if s.format != crate::import::swf::FORMAT_MP3 || s.frames.is_empty() {
                failed.push(FailedSound {
                    id: s.id as i64,
                    reason: "unsupported or empty sound".to_string(),
                });
                continue;
            }
            let buf = match crate::player::decode_bytes(&s.frames) {
                Ok(b) => b,
                Err(e) => {
                    // One corrupt sound must not kill a 50-sound import.
                    failed.push(FailedSound {
                        id: s.id as i64,
                        reason: e,
                    });
                    continue;
                }
            };
            let dest = dir.join(format!("{:02}_{}.mp3", i + 1, s.id));
            let final_path = self.atomic_write(&dest, &s.frames)?;
            let title = format!("{:02} · {}", i + 1, looper);
            match self.add_track(
                &title,
                &final_path,
                source_type,
                source_path,
                source_hash,
                s.id as i64,
                exe_offset,
                exe_length,
                "mp3",
                &buf,
                s.seek_samples as i64,
                s.trimmed_leading as i64,
            ) {
                Ok((id, true)) => {
                    added += 1;
                    track_ids.push(id);
                }
                Ok((id, false)) => {
                    // Raced or re-imported: drop the duplicate file.
                    let _ = std::fs::remove_file(&final_path);
                    already_there += 1;
                    track_ids.push(id);
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&final_path);
                    return Err(e);
                }
            }
        }
        if added == 0 && already_there == 0 {
            let _ = std::fs::remove_dir(&dir); // don't leave empty dirs
            return Err("no sounds could be imported".to_string());
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

impl Library {
    /// Import user audio files: validate → copy into `Custom Loops/` →
    /// BPM estimate → row. Per-file results; never touches originals.
    pub fn import_custom(&self, paths: &[String]) -> Vec<CustomReport> {
        paths.iter().map(|p| self.import_one_custom(p)).collect()
    }

    fn import_one_custom(&self, path: &str) -> CustomReport {
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
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("loop");
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
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let v: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if v > SCHEMA_VERSION {
        return Err(format!("database schema v{v} is newer than supported v{SCHEMA_VERSION}"));
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
    Ok(())
}

#[cfg(test)]
mod tests;
