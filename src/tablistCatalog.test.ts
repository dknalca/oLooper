import { expect, it, vi } from "vitest";
import { findRandomTablistLooper, isTablistLooperDownloaded, tablistCountsByRoute, tablistRouteKey } from "./tablistCatalog";
import type { TablistCatalogLooper, TablistCatalogPage } from "./tauri";

const looper = (path: string, loops: string[] = ["one", "two"]): TablistCatalogLooper => ({
  nid: path, path, loops, title: path, tags: [], image: "", date: "",
});
const page = (hits: TablistCatalogLooper[], estimatedTotalHits = 50): TablistCatalogPage => ({
  hits, estimatedTotalHits, limit: 24, offset: 0, skippedInvalidPaths: 0,
});

it.each([
  ["/loopers/one/", "loopers/one"],
  ["https://tablist.net/loopers/one/?q=x#section", "loopers/one"],
  ["https://www.tablist.net/loopers/one", "loopers/one"],
  ["https://example.com/path?x=1", "https://example.com/path"],
])("normalizes %s to %s for import counts", (input, expected) => {
  expect(tablistRouteKey(input)).toBe(expected);
});

it("aggregates counts for equivalent paths without treating empty loopers as complete", () => {
  const counts = tablistCountsByRoute([
    { source_path: "/loopers/one/", tracks: 1 },
    { source_path: "https://tablist.net/loopers/one?x=1", tracks: 2 },
  ]);
  expect(counts).toEqual({ "loopers/one": 3 });
  expect(isTablistLooperDownloaded(looper("loopers/one"), counts)).toBe(true);
  expect(isTablistLooperDownloaded(looper("loopers/one", []), counts)).toBe(false);
  expect(isTablistLooperDownloaded(looper("loopers/two"), counts)).toBe(false);
});

it("starts on a random page, wraps, skips complete loopers and chooses an eligible candidate", async () => {
  const complete = looper("loopers/complete");
  const first = looper("loopers/first");
  const second = looper("loopers/second");
  const search = vi.fn()
    .mockResolvedValueOnce(page([], 50))
    .mockResolvedValueOnce(page([complete]))
    .mockResolvedValueOnce(page([first, complete, second]));
  const random = vi.fn().mockReturnValueOnce(0.9).mockReturnValueOnce(0.9);
  expect(await findRandomTablistLooper(search, { "loopers/complete": 2 }, random)).toEqual(second);
  expect(search.mock.calls).toEqual([["", 0, 1], ["", 48], ["", 0]]);
});

it("allows an incomplete looper or one with an unknown track count", async () => {
  const unknown = looper("loopers/unknown", []);
  const search = vi.fn().mockResolvedValueOnce(page([], 1)).mockResolvedValueOnce(page([unknown]));
  expect(await findRandomTablistLooper(search, { "loopers/unknown": 9 }, () => 0)).toEqual(unknown);
});

it("reports an empty catalogue without requesting a results page", async () => {
  const search = vi.fn().mockResolvedValue(page([], 0));
  await expect(findRandomTablistLooper(search, {}, () => 0)).rejects.toThrow("The Tablist catalogue is empty.");
  expect(search).toHaveBeenCalledOnce();
});

it("reports when every valid looper is complete after checking every page", async () => {
  const complete = looper("loopers/complete");
  const search = vi.fn().mockResolvedValueOnce(page([], 25)).mockResolvedValue(page([complete]));
  await expect(findRandomTablistLooper(search, { "loopers/complete": 2 }, () => 0)).rejects.toThrow("Every valid looper in the Tablist catalogue is already downloaded.");
  expect(search.mock.calls).toEqual([["", 0, 1], ["", 0], ["", 24]]);
});

it("propagates a search failure without silently skipping a page", async () => {
  const search = vi.fn().mockResolvedValueOnce(page([], 25)).mockRejectedValueOnce(new Error("offline"));
  await expect(findRandomTablistLooper(search, {}, () => 0)).rejects.toThrow("offline");
  expect(search).toHaveBeenCalledTimes(2);
});
