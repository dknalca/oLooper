import { requestBpmReanalysis } from "../bpmReanalysis";
import { libraryGroupName } from "../libraryGroups";
import type { Playlist, Track } from "../tauri";

interface Props {
  title: string;
  search: string;
  sourceFilter: string;
  bpmFilter: string;
  durationFilter: string;
  hasFilters: boolean;
  selectedCount: number;
  playlist: Playlist | undefined;
  looper: Track | undefined;
  onSearch: (value: string) => void;
  onSourceFilter: (value: string) => void;
  onBpmFilter: (value: string) => void;
  onDurationFilter: (value: string) => void;
  onClear: () => void;
  onExport: () => void;
}

/** Library search, filter and scope controls; Sidebar owns the filter state. */
export default function LibraryTrackToolbar({ title, search, sourceFilter, bpmFilter, durationFilter, hasFilters, selectedCount, playlist, looper, onSearch, onSourceFilter, onBpmFilter, onDurationFilter, onClear, onExport }: Props) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
    <h2 className="mr-auto min-w-0 truncate text-xs font-semibold text-text">{title}</h2>
    <input type="search" aria-label="Search tracks" placeholder="Search tracks, loopers or tags…" value={search} onChange={(event) => onSearch(event.target.value)} className="min-w-24 flex-1 rounded-lg border border-border bg-app px-3 py-2 text-xs text-text placeholder:text-text-secondary focus:border-accent" />
    {hasFilters && <button onClick={onClear} className="toolbar-button">Clear filters</button>}
    <button onClick={() => requestBpmReanalysis({ kind: "library" }, "All tracks")} title="Reanalyze automatic BPMs across the entire library, ignoring filters; confirmed BPMs are preserved" className="toolbar-button">Reanalyze all BPM</button>
    {playlist && <button onClick={() => requestBpmReanalysis({ kind: "playlist", playlist_id: playlist.id }, playlist.name)} className="toolbar-button">Reanalyze playlist BPM</button>}
    {looper && looper.source_type !== "custom" && <button onClick={() => requestBpmReanalysis({ kind: "looper", source_hash: looper.source_hash }, libraryGroupName(looper))} className="toolbar-button">Reanalyze looper BPM</button>}
    <select value={sourceFilter} onChange={(event) => onSourceFilter(event.target.value)} aria-label="Filter source" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Source</option><option value="swf">SWF</option><option value="exe">EXE</option><option value="custom">Audio</option><option value="tablist">Tablist</option></select>
    <select value={bpmFilter} onChange={(event) => onBpmFilter(event.target.value)} aria-label="Filter BPM" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">BPM</option><option value="low">&lt;100</option><option value="mid">100–130</option><option value="high">&gt;130</option></select>
    <select value={durationFilter} onChange={(event) => onDurationFilter(event.target.value)} aria-label="Filter duration" className="rounded border border-border bg-elevated px-2 py-1 text-[10px] text-text"><option value="all">Length</option><option value="short">&lt;10s</option><option value="mid">10–30s</option><option value="long">&gt;30s</option></select>
    <button disabled={selectedCount === 0} onClick={onExport} className="rounded bg-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40">Export {selectedCount || ""}</button>
  </div>;
}
