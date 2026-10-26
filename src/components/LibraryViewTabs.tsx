export type LibraryView = "local" | "tablist";

interface Props {
  selected: LibraryView;
  onSelect: (view: LibraryView) => void;
  className?: string;
}

const VIEW_IDS: Record<LibraryView, string> = { local: "view-local", tablist: "view-tablist" };

export default function LibraryViewTabs({ selected, onSelect, className = "" }: Props) {
  const select = (view: LibraryView) => {
    onSelect(view);
    window.requestAnimationFrame(() => document.getElementById(VIEW_IDS[view])?.focus());
  };
  return (
    <div
      className={`flex min-w-0 items-center gap-1 ${className}`}
      role="tablist"
      aria-label="Library views"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        select(event.key === "Home" ? "local" : event.key === "End" ? "tablist" : selected === "local" ? "tablist" : "local");
      }}
    >
      <button role="tab" id={VIEW_IDS.local} aria-controls="library-panel" tabIndex={selected === "local" ? 0 : -1} aria-selected={selected === "local"} onClick={() => select("local")} className="view-tab min-w-0 flex-1 truncate px-2 py-2 text-[10px] sm:text-xs">My Library</button>
      <button role="tab" id={VIEW_IDS.tablist} aria-controls="library-panel" tabIndex={selected === "tablist" ? 0 : -1} aria-selected={selected === "tablist"} onClick={() => select("tablist")} className="view-tab min-w-0 flex-1 truncate px-2 py-2 text-[10px] sm:text-xs">Discover loopers</button>
    </div>
  );
}
