// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Playlist, Track } from "../tauri";
import LibraryTrackToolbar from "./LibraryTrackToolbar";

afterEach(cleanup);
const callbacks = () => ({ onSearch: vi.fn(), onSourceFilter: vi.fn(), onBpmFilter: vi.fn(), onDurationFilter: vi.fn(), onClear: vi.fn(), onExport: vi.fn() });
const base = { title: "Favorites", search: "", sourceFilter: "all", bpmFilter: "all", durationFilter: "all", hasFilters: false, selectedCount: 0, playlist: undefined, looper: undefined };

it("forwards search and filter changes, and only enables export for selected tracks", () => {
  const actions = callbacks();
  const view = render(<LibraryTrackToolbar {...base} {...actions} />);
  expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search tracks" }), { target: { value: "beat" } });
  fireEvent.change(screen.getByLabelText("Filter source"), { target: { value: "exe" } });
  fireEvent.change(screen.getByLabelText("Filter BPM"), { target: { value: "mid" } });
  fireEvent.change(screen.getByLabelText("Filter duration"), { target: { value: "long" } });
  expect(actions.onSearch).toHaveBeenCalledWith("beat");
  expect(actions.onSourceFilter).toHaveBeenCalledWith("exe");
  expect(actions.onBpmFilter).toHaveBeenCalledWith("mid");
  expect(actions.onDurationFilter).toHaveBeenCalledWith("long");
  view.rerender(<LibraryTrackToolbar {...base} {...actions} hasFilters selectedCount={2} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  fireEvent.click(screen.getByRole("button", { name: "Export 2" }));
  expect(actions.onClear).toHaveBeenCalledOnce();
  expect(actions.onExport).toHaveBeenCalledOnce();
});

it("requests BPM reanalysis for the selected scopes, not the visible filter", () => {
  const listener = vi.fn();
  window.addEventListener("olooper:reanalyze-bpm", listener);
  try {
    render(<LibraryTrackToolbar {...base} {...callbacks()} search="filter" playlist={{ id: 4, name: "Set", track_ids: [] } as Playlist}
      looper={{ source_type: "swf", source_hash: "hash", looper_name: "Pack" } as Track} />);
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze all BPM" }));
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze playlist BPM" }));
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze looper BPM" }));
    expect(listener.mock.calls.map(([event]) => (event as CustomEvent).detail.scope)).toEqual([
      { kind: "library" }, { kind: "playlist", playlist_id: 4 }, { kind: "looper", source_hash: "hash" },
    ]);
  } finally { window.removeEventListener("olooper:reanalyze-bpm", listener); }
});
