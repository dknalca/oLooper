// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useLibraryFilters } from "./useLibraryFilters";

afterEach(() => { cleanup(); localStorage.clear(); });

it("restores, persists and clears all filter choices", () => {
  localStorage.setItem("olooper.library.search", "scratch");
  localStorage.setItem("olooper.library.source", "swf");
  const view = renderHook(() => useLibraryFilters());
  expect(view.result.current).toMatchObject({ search: "scratch", sourceFilter: "swf", bpmFilter: "all", durationFilter: "all", hasFilters: true });
  act(() => {
    view.result.current.setBpmFilter("mid");
    view.result.current.setDurationFilter("long");
  });
  expect(localStorage.getItem("olooper.library.bpm")).toBe("mid");
  expect(localStorage.getItem("olooper.library.duration")).toBe("long");
  act(() => view.result.current.clearFilters());
  expect(view.result.current).toMatchObject({ search: "", sourceFilter: "all", bpmFilter: "all", durationFilter: "all", hasFilters: false });
  expect(localStorage.getItem("olooper.library.search")).toBe("");
  expect(localStorage.getItem("olooper.library.source")).toBe("all");
  expect(localStorage.getItem("olooper.library.bpm")).toBe("all");
  expect(localStorage.getItem("olooper.library.duration")).toBe("all");
});
