// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import IdleCoverScreensaver, { IdleCoverOverlay } from "./IdleCoverScreensaver";
import type { PlayerStatus, Track } from "../tauri";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(Element.prototype, "animate"); });
const image = { src: "data:image/png;base64,test", title: "Beat", path: "embedded:1", generation: 0, width: 512, height: 512 };

it("animates to the measured cover position and cancels animations on unmount", () => {
  const animations: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
  const animate = vi.fn(() => {
    const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
  const origin = document.createElement("div");
  vi.spyOn(origin, "getBoundingClientRect").mockReturnValue({ left: 20, top: 30, width: 100, height: 100 } as DOMRect);
  const ref = { current: origin };
  const finished = vi.fn();
  const view = render(<IdleCoverOverlay image={image} phase="entering" originRef={ref} onClose={vi.fn()} onTransitionEnd={finished} />);
  expect(screen.getByRole("dialog", { name: "Looper cover" })).toBeTruthy();
  expect(animate.mock.calls[0]).toBeTruthy();
  act(() => { animations[0].onfinish?.(); });
  expect(finished).toHaveBeenCalledOnce();
  view.unmount();
  expect(animations.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
});

it("reduced motion completes without scale animation or needing a cover origin", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const finished = vi.fn();
  render(<IdleCoverOverlay image={image} phase="entering" originRef={createRef<HTMLDivElement>()} onClose={vi.fn()} onTransitionEnd={finished} />);
  expect(finished).toHaveBeenCalledOnce();
  expect(screen.getByRole("img").getAttribute("draggable")).toBe("false");
});

it("keeps a valid cover through a pending automatic change and rejects late image callbacks", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const preloads: Array<{ onload: (() => void) | null; onerror: (() => void) | null }> = [];
  vi.stubGlobal("Image", class {
    naturalWidth = 512; naturalHeight = 512; src = "";
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor() { preloads.push(this); }
  });
  const track = { playback_path: "embedded:1", source_hash: "first", source_type: "swf", title: "First" } as Track;
  const status = { path: "embedded:1", loaded: true, playing: true, loading: false } as PlayerStatus;
  const props = { enabled: true, delayMs: 120_000, ready: true, libraryGeneration: 0, track, status, originRef: createRef<HTMLDivElement>(), cover: { sourceHash: "first", generation: 0, src: "first.jpg", pending: false } };
  const view = render(<IdleCoverScreensaver {...props} />);
  const lateLoad = preloads[0].onload;
  await act(async () => { preloads[0].onload?.(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(119_999); });
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole("img").getAttribute("src")).toBe("first.jpg");
  const next = { ...props, track: { ...track, playback_path: "embedded:2", source_hash: "second", title: "Second" }, status: { ...status, path: "embedded:2" }, cover: { sourceHash: "second", generation: 0, src: null as string | null, pending: true } };
  view.rerender(<IdleCoverScreensaver {...next} />);
  expect(screen.getByRole("img").getAttribute("src")).toBe("first.jpg");
  view.rerender(<IdleCoverScreensaver {...next} cover={{ ...next.cover, src: "second.jpg", pending: false }} />);
  await act(async () => { preloads[1].onload?.(); lateLoad?.(); });
  expect(screen.getByRole("img").getAttribute("src")).toBe("second.jpg");
  view.rerender(<IdleCoverScreensaver {...next} cover={{ ...next.cover, pending: false }} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
