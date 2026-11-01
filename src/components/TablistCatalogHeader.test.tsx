// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TablistCatalogHeader from "./TablistCatalogHeader";

afterEach(cleanup);
const actions = () => ({ onLibraryViewChange: vi.fn(), onSearch: vi.fn(), onRandom: vi.fn(), onPrevious: vi.fn(), onNext: vi.fn() });
const base = { libraryReady: true, search: "", pageNumber: 0, resultCount: 24, total: 50, loading: false, randomLoading: false, activeLooper: null };

it("forwards search, pagination and random actions", () => {
  const callbacks = actions();
  render(<TablistCatalogHeader {...base} {...callbacks} />);
  expect(screen.getByText("1–24 / 50")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Previous catalog page" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search Tablist loopers" }), { target: { value: "scratch" } });
  fireEvent.click(screen.getByRole("button", { name: "Next catalog page" }));
  fireEvent.click(screen.getByRole("button", { name: "Descargar Random Looper" }));
  expect(callbacks.onSearch).toHaveBeenCalledWith("scratch");
  expect(callbacks.onNext).toHaveBeenCalledOnce();
  expect(callbacks.onRandom).toHaveBeenCalledOnce();
});

it("disables pagination and search during an active import", () => {
  render(<TablistCatalogHeader {...base} {...actions()} activeLooper="loopers/one" pageNumber={1} />);
  expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Previous catalog page" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Next catalog page" }) as HTMLButtonElement).disabled).toBe(true);
});
