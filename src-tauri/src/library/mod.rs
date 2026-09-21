//! Persistent library: SQLite catalog + audio as normal files.
//!
//! The database is metadata only. Every write path keeps looper directories and
//! `Custom Loops/` human-browsable; file copies go `tmp → validate → rename`
//! and row writes are transactional. Removing a track deletes its row, never
//! the user's audio.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::import::swf::Sound;

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

/// A named cue/loop slot (A-D) attached to a track.
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

pub struct Library {
    conn: Connection,
    pub root: PathBuf,
}

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
                rusqlite::params![cue_ms, start_ms, end_ms, enabled, start_frame, end_frame, now_secs(), id],
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
    /// CASCADE deletes associated loop_slots.
    pub fn remove_track(&self, id: i64) -> Result<bool, String> {
        let n = self
            .conn
            .execute("DELETE FROM tracks WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(n == 1)
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

    pub fn update_metadata(&self, id: i64, title: &str, bpm: Option<f64>, tags: &str) -> Result<Track, String> {
        let title = sanitize_name(title);
        if let Some(bpm) = bpm {
            if !(20.0..=300.0).contains(&bpm) { return Err("bpm outside 20–300".to_string()); }
        }
        let tags = tags.split(',').map(sanitize_name).filter(|tag| tag != "untitled").collect::<Vec<_>>().join(", ");
        let changed = self.conn.execute("UPDATE tracks SET title=?1,bpm=?2,bpm_source=CASE WHEN ?2 IS NULL THEN bpm_source ELSE 'manual' END,tags=?3,updated_at=?4 WHERE id=?5", rusqlite::params![title, bpm, tags, now_secs(), id]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err(format!("track {id} not found")); }
        self.get_track(id)?.ok_or_else(|| format!("track {id} vanished"))
    }

    pub fn mark_played(&self, id: i64) -> Result<(), String> {
        let changed = self.conn.execute("UPDATE tracks SET last_played_at=?1 WHERE id=?2", rusqlite::params![now_secs(), id]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err(format!("track {id} not found")); }
        Ok(())
    }

    /// Copy selected audio to a user-owned directory. Never overwrite or move a source.
    pub fn export_tracks(&self, ids: &[i64], destination: &Path) -> Result<usize, String> {
        if ids.is_empty() { return Err("select at least one loop to export".to_string()); }
        let destination = destination.canonicalize().map_err(|e| format!("cannot use export folder: {e}"))?;
        if !destination.is_dir() { return Err("export destination is not a folder".to_string()); }
        let mut exported = 0;
        for id in ids {
            let track = self.get_track(*id)?.ok_or_else(|| format!("track {id} not found"))?;
            let source = Path::new(&track.file_path);
            if !source.is_file() { return Err(format!("audio for '{}' is missing", track.title)); }
            let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("wav");
            let stem = sanitize_name(&track.title);
            let mut target = destination.join(format!("{stem}.{extension}"));
            for suffix in 2..=10_000 {
                if !target.exists() { break; }
                target = destination.join(format!("{stem} ({suffix}).{extension}"));
            }
            if target.exists() { return Err(format!("too many files named '{stem}' in export folder")); }
            std::fs::copy(source, &target).map_err(|e| format!("cannot export '{}': {e}", track.title))?;
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

    /// Rename the derived-audio folder and its catalog label. Source files stay untouched.
    pub fn rename_looper(&self, source_hash: &str, new_name: &str) -> Result<(), String> {
        let tracks = self.group_tracks(source_hash)?;
        if tracks[0].source_type == "custom" {
            return Err("custom loops cannot be renamed as a group".to_string());
        }
        let new_name = sanitize_name(new_name);
        let old_dir = self.group_directory(source_hash)?;
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

    /// Remove metadata and slots only; preserved sources and audio stay on disk.
    pub fn remove_looper(&self, source_hash: &str) -> Result<usize, String> {
        let n = self
            .conn
            .execute("DELETE FROM tracks WHERE source_hash=?1", [source_hash])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("looper group not found".to_string());
        }
        Ok(n)
    }

    // --- Loop slots ---

    pub fn get_slots(&self, track_id: i64) -> Result<Vec<LoopSlot>, String> {
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

    pub fn set_slot(
        &self,
        track_id: i64,
        slot: i64,
        label: &str,
        cue_ms: i64,
        loop_start_ms: i64,
        loop_end_ms: i64,
        enabled: bool,
    ) -> Result<LoopSlot, String> {
        if !(1..=4).contains(&slot) {
            return Err("slot must be 1–4".to_string());
        }
        self.get_track(track_id)?
            .ok_or_else(|| format!("track {track_id} not found"))?;
        self.conn
            .execute(
                "INSERT INTO loop_slots(track_id,slot,label,cue_ms,loop_start_ms,loop_end_ms,enabled) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7) \
                 ON CONFLICT(track_id,slot) DO UPDATE SET \
                 label=excluded.label,cue_ms=excluded.cue_ms,loop_start_ms=excluded.loop_start_ms,\
                 loop_end_ms=excluded.loop_end_ms,enabled=excluded.enabled",
                rusqlite::params![track_id, slot, label, cue_ms, loop_start_ms, loop_end_ms, enabled],
            )
            .map_err(|e| e.to_string())?;
        let id: i64 = self
            .conn
            .query_row(
                "SELECT id FROM loop_slots WHERE track_id=?1 AND slot=?2",
                rusqlite::params![track_id, slot],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(LoopSlot {
            id,
            track_id,
            slot,
            label: label.to_string(),
            cue_ms,
            loop_start_ms,
            loop_end_ms,
            enabled,
        })
    }

    pub fn delete_slot(&self, track_id: i64, slot: i64) -> Result<bool, String> {
        let n = self
            .conn
            .execute(
                "DELETE FROM loop_slots WHERE track_id=?1 AND slot=?2",
                rusqlite::params![track_id, slot],
            )
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

    /// Persist extracted sounds: files under `<looper>/` + rows.
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
        mp3_bytes: &[u8],
        seek_samples: u16,
        sample_count: u32,
    ) -> Option<(crate::player::LoopBuffer, Vec<u8>)> {
        if seek_samples == 0 && sample_count == 0 {
            return None;
        }
        let buf = crate::player::decode_bytes(mp3_bytes).ok()?;
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
        mut progress: F,
    ) -> Result<ImportReport, (ImportReport, String)>
    where
        F: FnMut(&str, usize, usize) -> Result<(), String>,
    {
        if sounds.is_empty() {
            return Err((ImportReport { looper: looper.to_string(), added: 0, already_there: 0, failed: vec![], track_ids: vec![] }, "no extractable sounds".to_string()));
        }
        let looper = sanitize_name(looper);
        let dir = self.root.join(&looper);
        std::fs::create_dir_all(&dir).map_err(|e| {
            let partial = ImportReport { looper: looper.clone(), added: 0, already_there: 0, failed: vec![], track_ids: vec![] };
            (partial, format!("cannot create looper dir: {e}"))
        })?;

        let mut added = 0;
        let mut already_there = 0;
        let mut failed = Vec::new();
        let mut track_ids = Vec::new();
        let make_partial = |looper: &str, added: usize, already_there: usize, failed: Vec<FailedSound>, track_ids: Vec<i64>| {
            ImportReport { looper: looper.to_string(), added, already_there, failed, track_ids }
        };
        for (i, s) in sounds.iter().enumerate() {
            let current = i + 1;
            let total = sounds.len();
            // Skip known rows before touching the filesystem.
            let known: Option<i64> = self
                .conn
                .query_row(
                    "SELECT id FROM tracks WHERE source_hash=?1 AND source_sound_id=?2",
                    rusqlite::params![source_hash, s.id as i64],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e.to_string()))?;
            if let Some(id) = known {
                already_there += 1;
                track_ids.push(id);
                continue;
            }
            if s.frames.is_empty() {
                failed.push(FailedSound {
                    id: s.id as i64,
                    reason: "unsupported or empty sound".to_string(),
                });
                continue;
            }
            progress("extracting", current, total).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
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
            // MP3 gapless: trim encoder priming + trailing padding when SWF
            // provides seek_samples / sample_count.  The trimmed result is
            // written as WAV so the player loads exact-length PCM without
            // needing metadata at load time.
            let (buf, file_bytes, file_codec) =
                if s.codec == "mp3" && (s.seek_samples > 0 || s.sample_count > 0) {
                    if let Some((trimmed, wav)) =
                        Self::trim_mp3_gapless(&s.frames, s.seek_samples, s.sample_count)
                    {
                        (trimmed, wav, "wav".to_string())
                    } else {
                        (buf, s.frames.clone(), s.codec.clone())
                    }
                } else {
                    (buf, s.frames.clone(), s.codec.clone())
                };
            progress("adjusting BPM", current, total).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
            let estimate = crate::analysis::estimate(&buf);
            progress("adjusting loops", current, total).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
            let dest = dir.join(format!("{:02}_{}.{}", i + 1, s.id, file_codec));
            let final_path = self.atomic_write(&dest, &file_bytes).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
            let title = format!("{:02} · {}", i + 1, looper);
            progress("inserting in library", current, total).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
            match self.add_track(
                &title,
                &looper,
                &final_path,
                source_type,
                source_path,
                source_hash,
                s.id as i64,
                exe_offset,
                exe_length,
                &file_codec,
                &buf,
                0, // seek_samples already applied
                0, // trimmed_leading already applied
            ) {
                Ok((id, true)) => {
                    if let Some(estimate) = estimate {
                        self.update_bpm(id, estimate.bpm, Some(estimate.confidence), false).map_err(|e| (make_partial(&looper, added, already_there, failed.clone(), track_ids.clone()), e))?;
                    }
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
                    return Err((make_partial(&looper, added, already_there, failed, track_ids), e));
                }
            }
        }
        if added == 0 && already_there == 0 {
            let _ = std::fs::remove_dir(&dir); // don't leave empty dirs
            return Err((make_partial(&looper, 0, 0, failed, track_ids), "no sounds could be imported".to_string()));
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
