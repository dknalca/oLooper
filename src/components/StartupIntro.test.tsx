// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import StartupIntro from "./StartupIntro";

vi.mock("../scratchQuotes", () => ({ randomScratchQuote: () => ({ text: "Keep the beat", attribution: "A DJ", source: "Test" }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the intro quote horizontally centered while its inner content fades upward", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const calls: Array<{ element: Element; frames: Keyframe[] }> = [];
  const animate = vi.fn(function (this: Element, frames: Keyframe[]) {
    calls.push({ element: this, frames });
    return { finished: new Promise<void>(() => {}), cancel: vi.fn() } as unknown as Animation;
  });
  Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });

  render(<StartupIntro onComplete={vi.fn()} />);

  const centered = screen.getByText("“Keep the beat”").closest("[data-intro-quote-center]");
  const moving = document.querySelector("[data-intro-quote-transition]");
  expect(centered?.classList.contains("-translate-x-1/2")).toBe(true);
  expect(moving?.classList.contains("-translate-x-1/2")).toBe(false);
  expect(calls[1].element).toBe(moving);
  expect(calls[1].frames).toEqual([
    { opacity: 1, transform: "translateY(0)" },
    { opacity: 0, transform: "translateY(-16px)" },
  ]);
});
