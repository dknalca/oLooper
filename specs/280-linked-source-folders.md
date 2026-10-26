# 280 — Linked source folders and manual reconciliation

Status: implemented in the unreleased working tree.

## User behavior

- Importing a folder remembers its canonical path, recursive scope and chosen
  extraction/source-copy options in that library's catalog, including empty folders.
- The existing **Folder** button opens the remembered folders and **Import folder…**.
  Each folder shows its full path and a **Rescan** action. A looper context menu and
  missing-audio dialog also offer **Rescan source folder…**.
- Rescanning adds new/changed SWF/EXE contents through the existing bounded import
  queue. Unchanged successfully imported contents are skipped without decoding.
- Losing the original container never removes extracted audio that still exists.
  Embedded playback depends on its actual source path: a surviving managed copy
  keeps the tracks available even if the external original is gone.
- Only tracks whose required audio has disappeared are removed, with playlist
  references cascading. Other tracks, favorites, metadata and playlists survive.
  A missing extracted file is not recreated from an unchanged original by rescan.
- Identical embedded original content moved within the folder is relinked while
  preserving track IDs. Changed original content is imported as a new identity;
  extracted audio from previous versions is retained while it remains available.
- A missing/unreadable source folder, failed enumeration/hash, or inaccessible
  dependency parent aborts reconciliation before catalog removal. Unix volume
  identity is checked so an unmounted volume's empty mount point is not treated
  as an empty source folder. Windows relies on normal filesystem access errors.
- Reconciliation never deletes physical files. The missing-audio dialog's separate
  manual **Remove this track** action retains normal explicit removal semantics.

## Persistence and IPC

- Schema v11 adds `linked_folders` (path, import choices, optional Unix device ID)
  and `linked_folder_sources` (folder/hash association and successful-completion
  flag). Historical hash associations remain after files disappear, so surviving
  extracted tracks retain their folder action and intentionally removed audio
  is not resurrected on every scan.
- Original-to-folder association is recorded by the import worker before its final
  event, even when playback uses a copied container. Partial imports are associated
  but remain retryable. A folder imported with older builds can be linked by
  importing it once again; copied historical containers alone cannot recover their
  former external folder.
- Commands: `library_link_folder`, `library_linked_folders`,
  `library_source_folders`, `library_rescan_folder`, `import_linked_file`.
- `LinkedFolder`: `id`, `path`, `extract_audio`, `copy_source`, `library_root`.
  `FolderScan`: `folder`, `paths`, `removed`, `unchanged` (container counts).
- Enumeration and streaming SHA-256 run off the UI thread, with 64 KiB hash
  scratch, 512 MiB/file, 100,000 entries and 10,000 containers maximum. Symlinks
  are not enumerated; projectors are never executed.
- Reconciliation uses a separate WAL connection and the library mutation guard;
  catalog removals/path relinks commit together. Imports then run sequentially,
  with ordinary progress/cancellation and per-file failures. Already committed
  reconciliation is not rolled back if a subsequent import is cancelled/fails.
- Rescan and import admission carry the captured library root and reject a stale
  folder selection after a library switch. Subscribe before enqueueing each job.
- Library-track load admission checks that the backing file still exists even
  when its decoded PCM was prefetched. A failure also refreshes availability for
  the missing-audio prompt. Audio already loaded in memory is not forcibly stopped.

## Verification

Automated coverage includes v10 migration, reopen persistence, unchanged/new/
changed content, preservation without original input, surviving managed copies,
missing individual audio and playlist cleanup, deleted subdirectories, missing
roots, Unix device mismatch, embedded relocation and avoiding re-creation of
deleted audio. Frontend coverage exercises folder selection, root-pinned imports,
empty folder persistence, error reporting and the missing extracted-audio action.

Native Finder/disconnected-drive UX and Windows volume behavior still require
manual platform validation; automated tests do not constitute device validation.
