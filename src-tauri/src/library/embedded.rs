//! Bounded, shared container cache for playback and background analysis.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

use crate::import::swf::SoundSource;

const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;
const CACHE_MAX_SOURCES: usize = 2;
static CACHE: OnceLock<Mutex<SourceCache>> = OnceLock::new();

pub(crate) fn trim_source_cache() {
    let budget = crate::memory::cache_budget(CACHE_MAX_BYTES);
    if let Some(cache) = CACHE.get() {
        if let Ok(mut cache) = cache.lock() {
            cache.trim_to(budget);
        }
    }
}

#[derive(PartialEq, Eq)]
struct SourceKey {
    path: String,
    source_type: String,
    hash: String,
    size: u64,
    modified: std::time::SystemTime,
    // Detect replacements and same-size rewrites even with a restored mtime.
    #[cfg(unix)]
    unix_identity: (u64, u64, i64, i64),
}

impl SourceKey {
    fn new(
        path: &str,
        source_type: &str,
        hash: &str,
        metadata: &std::fs::Metadata,
    ) -> Option<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            path: path.to_string(),
            source_type: source_type.to_string(),
            hash: hash.to_string(),
            size: metadata.len(),
            modified: metadata.modified().ok()?,
            #[cfg(unix)]
            unix_identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }
}

#[derive(Default)]
struct SourceCache {
    entries: VecDeque<(SourceKey, Arc<SoundSource>)>,
}

impl SourceCache {
    fn get(&mut self, key: &SourceKey, budget: usize) -> Option<Arc<SoundSource>> {
        self.trim_to(budget);
        self.entries
            .retain(|(old, _)| old.path != key.path || old == key);
        let index = self.entries.iter().position(|(old, _)| old == key)?;
        let entry = self.entries.remove(index)?;
        let source = entry.1.clone();
        self.entries.push_back(entry);
        Some(source)
    }

    fn insert(&mut self, key: SourceKey, source: Arc<SoundSource>, budget: usize) {
        self.entries.retain(|(old, _)| old.path != key.path);
        self.trim_to(budget);
        if source.memory_bytes() > budget {
            return;
        }
        while self.entries.len() >= CACHE_MAX_SOURCES
            || self
                .entries
                .iter()
                .map(|(_, source)| source.memory_bytes())
                .sum::<usize>()
                + source.memory_bytes()
                > budget
        {
            self.entries.pop_front();
        }
        self.entries.push_back((key, source));
    }

    fn trim_to(&mut self, budget: usize) {
        while self
            .entries
            .iter()
            .map(|(_, source)| source.memory_bytes())
            .sum::<usize>()
            > budget
        {
            if self.entries.pop_front().is_none() {
                break;
            }
        }
    }
}

fn source(path: &str, source_type: &str, expected_hash: &str) -> Result<Arc<SoundSource>, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(SourceCache::default()));
    let file = std::fs::File::open(path).map_err(|error| format!("cannot open source: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("cannot inspect source: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SOURCE_BYTES {
        return Err("source exceeds the 512 MiB limit".to_string());
    }
    let key = SourceKey::new(path, source_type, expected_hash, &metadata);
    let budget = crate::memory::cache_budget(CACHE_MAX_BYTES);
    if let Some(source) = key
        .as_ref()
        .and_then(|key| cache.lock().ok()?.get(key, budget))
    {
        return Ok(source);
    }
    // No cache lock during I/O, hashing, decompression, parsing, or decoding.
    let limit = crate::memory::working_budget(MAX_SOURCE_BYTES as usize) as u64;
    if metadata.len() > limit {
        return Err("source exceeds the current working memory budget".into());
    }
    let mut data = Vec::new();
    crate::bounded_io::read_into(&file, &mut data, limit)
        .map_err(|error| format!("cannot read source: {error}"))?;
    if data.len() as u64 > MAX_SOURCE_BYTES {
        return Err("source exceeds the 512 MiB limit".to_string());
    }
    if super::sha256_hex(&data) != expected_hash {
        return Err("the SWF/EXE source changed after import".to_string());
    }
    let swf_data = match source_type {
        "swf" => data.as_slice(),
        "exe" => {
            let found = crate::import::exe::locate(&data)
                .map_err(|error| crate::import::exe::user_message(&error))?;
            &data[found.offset..found.offset + found.length]
        }
        _ => return Err("unsupported source-backed audio type".to_string()),
    };
    let source = Arc::new(
        SoundSource::new(swf_data).map_err(|error| crate::import::swf::user_message(&error))?,
    );
    if let Some(key) = key {
        let after = file
            .metadata()
            .map_err(|error| format!("cannot inspect source: {error}"))?;
        if SourceKey::new(path, source_type, expected_hash, &after).as_ref() != Some(&key) {
            return Err("source changed while it was loading; load it again".to_string());
        }
        let budget = crate::memory::cache_budget(CACHE_MAX_BYTES);
        if let Ok(mut cache) = cache.lock() {
            cache.insert(key, source.clone(), budget);
        }
    }
    Ok(source)
}

pub(crate) fn decode_embedded_sound_file(
    path: &str,
    source_type: &str,
    sound_id: u16,
    expected_hash: &str,
) -> Result<crate::player::LoopBuffer, String> {
    let source = source(path, source_type, expected_hash)?;
    let parsed = source
        .parse_sound(sound_id)
        .map_err(|error| crate::import::swf::user_message(&error))?;
    let sound = parsed
        .sounds
        .iter()
        .find(|sound| sound.id == sound_id)
        .ok_or_else(|| format!("embedded sound {sound_id} was not found in the source"))?;
    let buffer = crate::player::decode_bytes(&sound.frames)?;
    if sound.codec == "mp3" {
        if let Some(trimmed) =
            super::Library::trim_mp3_buffer(&buffer, sound.seek_samples, sound.sample_count)
        {
            return Ok(trimmed);
        }
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn compressed_swf() -> Vec<u8> {
        let body = [0u8; 7]; // RECT, frame rate/count, End tag
        let mut data = b"CWS\x0a".to_vec();
        data.extend_from_slice(&15u32.to_le_bytes());
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&body).unwrap();
        data.extend(encoder.finish().unwrap());
        data
    }

    #[test]
    fn container_cache_reuses_verified_compressed_swf_and_exe() {
        let root = tempfile::tempdir().unwrap();
        let swf = compressed_swf();
        let mut exe = vec![0; 128];
        exe[..2].copy_from_slice(b"MZ");
        exe.extend_from_slice(&swf);
        for (kind, data) in [("swf", swf), ("exe", exe)] {
            let path = root.path().join(kind);
            std::fs::write(&path, &data).unwrap();
            let path = path.to_str().unwrap();
            let hash = super::super::sha256_hex(&data);
            let first = source(path, kind, &hash).unwrap();
            let second = source(path, kind, &hash).unwrap();
            assert!(Arc::ptr_eq(&first, &second));
            assert!(second.parse_sound(42).unwrap().sounds.is_empty());
            assert!(source(path, kind, "incorrect hash").is_err());
            assert!(source(path, "unsupported", &hash).is_err());
            let _warm = source(path, kind, &hash).unwrap();
            // Same-size modification must not reuse the verified container.
            let mut changed = data.clone();
            changed[0] ^= 1;
            std::fs::write(path, changed).unwrap();
            assert!(source(path, kind, &hash)
                .err()
                .unwrap()
                .contains("changed after import"));
            std::fs::write(path, &data).unwrap();
            let _warm = source(path, kind, &hash).unwrap();
            std::fs::remove_file(path).unwrap();
            assert!(source(path, kind, &hash).is_err());
        }
    }

    #[test]
    fn container_cache_evicts_least_recent_source_and_respects_byte_budget() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("source.swf");
        std::fs::write(&path, compressed_swf()).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        let key = |name| SourceKey::new(name, "swf", "hash", &metadata).unwrap();
        let small = Arc::new(SoundSource::new(&compressed_swf()).unwrap());
        let mut cache = SourceCache::default();
        cache.insert(key("a"), small.clone(), CACHE_MAX_BYTES);
        cache.insert(key("b"), small.clone(), CACHE_MAX_BYTES);
        assert!(cache.get(&key("a"), CACHE_MAX_BYTES).is_some());
        cache.insert(key("c"), small.clone(), CACHE_MAX_BYTES);
        assert!(cache.get(&key("b"), CACHE_MAX_BYTES).is_none());
        assert!(cache.get(&key("a"), CACHE_MAX_BYTES).is_some());

        // A source exceeding the current dynamic budget is not retained.
        cache.insert(key("large"), small, 1);
        assert!(
            cache.entries.is_empty(),
            "oversized insertion must also trim old entries"
        );
        assert!(cache.get(&key("large"), 1).is_none());
        assert!(
            cache
                .entries
                .iter()
                .map(|(_, s)| s.memory_bytes())
                .sum::<usize>()
                <= CACHE_MAX_BYTES
        );
    }
}
