// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import LibraryEmptyState from "./LibraryEmptyState";

afterEach(cleanup);
const props = { libraryReady: true, catalogLoaded: true, trackCount: 0, selectedTrackCount: 0, hasFilters: false, favoritesSelected: false, onClearFilters: vi.fn(), onBrowseAll: vi.fn() };

it("offers library selection before initialization and a loading state afterwards", () => {
  const choose = vi.fn();
  window.addEventListener("olooper:choose-library", choose);
  try {
    const view = render(<LibraryEmptyState {...props} libraryReady={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose library folder" }));
    expect(choose).toHaveBeenCalledOnce();
    view.rerender(<LibraryEmptyState {...props} catalogLoaded={false} />);
    expect(screen.getByRole("status").textContent).toContain("Loading your library");
  } finally { window.removeEventListener("olooper:choose-library", choose); }
});

it("invites a first import even when filters are active", () => {
  const request = vi.fn();
  window.addEventListener("olooper:import-command", request);
  try {
    render(<LibraryEmptyState {...props} hasFilters />);
    expect(screen.getByText("Bring your first loop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import files" }));
    expect((request.mock.calls[0][0] as CustomEvent).detail).toBe("import-files");
  } finally { window.removeEventListener("olooper:import-command", request); }
});

it("offers to clear filters or browse all tracks for an empty collection", () => {
  const clear = vi.fn();
  const browse = vi.fn();
  const view = render(<LibraryEmptyState {...props} trackCount={3} hasFilters onClearFilters={clear} onBrowseAll={browse} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(clear).toHaveBeenCalledOnce();
  view.rerender(<LibraryEmptyState {...props} trackCount={3} favoritesSelected onClearFilters={clear} onBrowseAll={browse} />);
  expect(screen.getByText("Your favorites belong here")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Browse all tracks" }));
  expect(browse).toHaveBeenCalledOnce();
  view.rerender(<LibraryEmptyState {...props} trackCount={3} selectedTrackCount={1} />);
  expect(screen.queryByRole("button")).toBeNull();
});
