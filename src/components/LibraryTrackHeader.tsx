interface Props {
  columns: string;
  playlistSelected: boolean;
  showLooperColumn: boolean;
  sort: "alphabetical" | "bpm";
  bpmDescending: boolean;
  onSortAlphabetically: () => void;
  onSortBpm: () => void;
}

/** Column labels and sort actions; Sidebar retains sorting and playlist order. */
export default function LibraryTrackHeader({ columns, playlistSelected, showLooperColumn, sort, bpmDescending, onSortAlphabetically, onSortBpm }: Props) {
  return <div className={`grid ${columns} gap-2 border-b border-border bg-elevated/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary`}>
    {playlistSelected ? <span>Playlist order</span> : <button onClick={onSortAlphabetically}
      aria-sort={sort === "alphabetical" ? "ascending" : "none"} className="truncate text-left hover:text-text" title="Sort loops alphabetically">
      Loop{sort === "alphabetical" ? " ↑" : ""}
    </button>}
    {showLooperColumn && <span className="truncate text-left">Looper</span>}
    {playlistSelected ? <span className="text-right">BPM</span> : <button onClick={onSortBpm}
      aria-sort={sort === "bpm" ? (bpmDescending ? "descending" : "ascending") : "none"}
      className="text-right hover:text-text" title="Sort loops by BPM">
      BPM{sort === "bpm" ? (bpmDescending ? " ↓" : " ↑") : ""}
    </button>}
    <span className="text-right">Length</span><span className="text-right">Actions</span>
  </div>;
}
