interface Props {
  libraryReady: boolean;
  catalogLoaded: boolean;
  trackCount: number;
  selectedTrackCount: number;
  hasFilters: boolean;
  favoritesSelected: boolean;
  onClearFilters: () => void;
  onBrowseAll: () => void;
}

/** Empty-library, filtered and empty-collection guidance, independent of catalog state. */
export default function LibraryEmptyState({ libraryReady, catalogLoaded, trackCount, selectedTrackCount, hasFilters, favoritesSelected, onClearFilters, onBrowseAll }: Props) {
  if (!libraryReady) return <div className="empty-state">
    <h3 className="text-base font-semibold text-text">Your practice space starts here</h3>
    <p>Choose a folder for your library, then bring in your favorite loops.</p>
    <button className="toolbar-button" onClick={() => window.dispatchEvent(new Event("olooper:choose-library"))}>Choose library folder</button>
  </div>;
  if (!catalogLoaded) return <p className="empty-state" role="status">Loading your library…</p>;
  if (selectedTrackCount !== 0) return null;
  const emptyLibrary = trackCount === 0;
  const title = emptyLibrary ? "Bring your first loop" : hasFilters ? "No matching tracks" : favoritesSelected ? "Your favorites belong here" : "This collection is empty";
  const description = emptyLibrary ? "Import SWF, EXE or audio files, or drop them into this window." : hasFilters ? "Try another search or clear your filters to see more tracks." : favoritesSelected ? "Use the heart beside any track to keep it close for your next session." : "Add tracks from their context menu, or drag them onto a playlist.";
  return <div className="empty-state">
    <h3 className="text-base font-semibold text-text">{title}</h3>
    <p>{description}</p>
    {emptyLibrary
      ? <button className="toolbar-button" onClick={() => window.dispatchEvent(new CustomEvent("olooper:import-command", { detail: "import-files" }))}>Import files</button>
      : hasFilters
        ? <button className="toolbar-button" onClick={onClearFilters}>Clear filters</button>
        : <button className="toolbar-button" onClick={onBrowseAll}>Browse all tracks</button>}
  </div>;
}
