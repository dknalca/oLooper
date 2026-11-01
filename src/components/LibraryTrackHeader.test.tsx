// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LibraryTrackHeader from "./LibraryTrackHeader";

afterEach(cleanup);
const props = { columns: "grid-cols-4", playlistSelected: false, showLooperColumn: true, sort: "alphabetical" as const, bpmDescending: false, onSortAlphabetically: vi.fn(), onSortBpm: vi.fn() };

it("reflects sorting direction and forwards sort actions", () => {
  const alphabetic = vi.fn();
  const bpm = vi.fn();
  const view = render(<LibraryTrackHeader {...props} onSortAlphabetically={alphabetic} onSortBpm={bpm} />);
  expect(screen.getByTitle("Sort loops alphabetically").getAttribute("aria-sort")).toBe("ascending");
  fireEvent.click(screen.getByTitle("Sort loops by BPM"));
  expect(bpm).toHaveBeenCalledOnce();
  view.rerender(<LibraryTrackHeader {...props} sort="bpm" bpmDescending onSortAlphabetically={alphabetic} onSortBpm={bpm} />);
  expect(screen.getByTitle("Sort loops by BPM").getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(screen.getByTitle("Sort loops alphabetically"));
  expect(alphabetic).toHaveBeenCalledOnce();
});

it("keeps playlist ordering non-sortable and conditionally shows the looper column", () => {
  const view = render(<LibraryTrackHeader {...props} playlistSelected showLooperColumn={false} />);
  expect(screen.getByText("Playlist order")).toBeTruthy();
  expect(screen.queryByTitle("Sort loops by BPM")).toBeNull();
  expect(screen.queryByText("Looper")).toBeNull();
  view.rerender(<LibraryTrackHeader {...props} playlistSelected />);
  expect(screen.getByText("Looper")).toBeTruthy();
});
