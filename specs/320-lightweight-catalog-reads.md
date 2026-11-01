# 320 — Short-lived availability observations and lightweight Random selection

## Scope

Reduce repeated filesystem observations when catalog tracks share a container,
and avoid hydrating/stat-ing the entire catalog to choose a Random track. No
schema migration, IPC payload, playback scheduling or audio processing changes.

## Catalog reads

- Keep the existing ordered `Track` projection and indexed point lookup.
- Share a file-availability observation by exact stored path within one catalog
  operation, including positive and negative results for embedded sources.
- Bound this temporary table to 4096 entries and 512 KiB of retained path text.
  Map overhead and the result rows are separate allocations. At either limit,
  probe uncached paths normally; never guess `exists` or drop catalog rows.
- Discard observations at the end of the operation. Subsequent listing, point
  lookup and playback admission must observe the filesystem again. There is no
  global cache, TTL, background watcher or path canonicalization for deduplication.
- Preserve `Path::is_file` semantics: directories and unavailable paths are
  false; symlink handling is unchanged. `exists` remains an observation, not a
  security check or a guarantee the file cannot subsequently change.

## Random selection

1. Read only candidate `(id, file_path)` pairs, applying the optional source hash
   in SQLite. Release the scan before point lookups, without a new long-lived
   transaction or library-wide writer lock.
2. Set aside the current track only if its ID belongs to that scope.
3. Draw candidate indices without replacement, using the existing SQLite entropy
   and integer-to-index mapping. Check the drawn path and skip missing candidates
   without hydrating their metadata. Reuse observations of shared source paths.
4. Hydrate a playable candidate by primary key, rechecking the source hash and
   current row/path. A deleted or rescoped row is skipped, not returned outside
   the requested scope. Every track is a candidate, not every distinct container;
   missing neighbors do not trigger a nearest-ID fallback.
5. Return the excluded track only if no other candidate is playable, and only if
   it still passes scope and availability checks. Return `None` for an empty or
   wholly unavailable selection; preserve SQL/selection errors as errors.
6. Membership and candidate paths come from the initial scan. Later imports or
   relocated formerly unavailable paths can be considered on the next call.
   Per-operation filesystem observations are not an atomic filesystem snapshot.
7. Preserve playback's independent admission, regular-file/path checks, source
   hash/identity validation, decoding limits and newest-load ownership. No audio
   is opened, decoded, extracted or copied during candidate selection.

## Cost and limits

A healthy draw checks one path and hydrates one full row instead of all tracks.
The candidate vector is still O(N) in IDs/path strings. With many missing tracks,
selection can still examine every candidate and issue one entropy query per draw;
there is no claimed constant-time or universally faster worst case. Availability
deduplication is bounded and temporary, not a total process memory budget.

## Regression criteria

- Count real filesystem probes through the catalog path: 64 interleaved embedded
  rows referencing one present and one missing path need two probes.
- Point lookup probes only its row; subsequent calls detect removed/restored
  files and directories. A prior positive read cannot authorize playback later.
- A healthy 256-track Random selection probes one path. Missing/unselected rows
  do not require full DTO hydration; selected metadata matches normal lookup.
- Check excluded-only, missing-all, empty/out-of-scope and shared-container cases.
- Enumerate first/second index draws deterministically to verify missing-neighbor
  rejection does not bias the choice by catalog order. Each embedded sound remains
  individually eligible regardless of sharing its container.
- A separate SQLite connection can delete/rescope a row between scan and lookup;
  it must never leak into the selection. Selection errors must propagate.
- Test entry/text limits and fallback probes, including negative observations.

These tests do not measure physical audio continuity, native A/B latency, total
RAM savings or performance on slow external volumes. Use the existing offline
Cargo cache with one build job; no installation or app-bundle rebuild is needed.

## Validation record — 2026-10-29

- `CARGO_BUILD_JOBS=1 cargo test --offline --manifest-path src-tauri/Cargo.toml -- --test-threads=2`:
  **291 passed, zero failed, four ignored** (external fixtures). This includes
  eleven catalog/Random regressions and four temporary-observation bound tests.
- The counted cases above pass: two path probes for 64 shared-source rows, one
  probe for a healthy 256-track Random draw, and two probes when 32 unavailable
  embedded tracks share a path and the current track is the only fallback.
- Targeted `rustfmt --check` on the three affected Rust files and `git diff --check`
  pass. No dependency changes, installations or native app-bundle rebuild.
