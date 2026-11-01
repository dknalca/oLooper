// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createLibraryCoverCache } from "../libraryCoverCache";
import LibraryCoverThumbnail from "./LibraryCoverThumbnail";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("requests only visible thumbnails and releases their displayed image when hidden", async () => {
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} disconnect = disconnect;
  });
  const load = vi.fn().mockResolvedValue("data:image/jpeg;base64,AAAA");
  const view = render(<LibraryCoverThumbnail cache={createLibraryCoverCache(load)} scope={{ generation: 1, revision: 0 }} sourceHash="pack" />);
  expect(load).not.toHaveBeenCalled();
  await act(async () => { intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
  expect(load).toHaveBeenCalledExactlyOnceWith("pack");
  expect(view.container.querySelector("img")).not.toBeNull();
  act(() => intersect([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(view.container.querySelector("img")).toBeNull();
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
