// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useIdleCover from "./useIdleCover";
import { IDLE_COVER_DELAY_MS } from "../appPreferences";

function Harness({ enabled = true, eligible = true, scopeKey = 0, modal = false }) {
  const idle = useIdleCover({ enabled, canEnter: eligible, canRemain: eligible, scopeKey });
  const [clicks, setClicks] = useState(0);
  useEffect(() => { if (idle.phase === "entering" || idle.phase === "leaving") idle.finishTransition(); }, [idle.phase, idle.finishTransition]);
  return <><output aria-label="Phase">{idle.phase}</output><button onClick={() => setClicks((count) => count + 1)}>Underlying {clicks}</button>{modal && <div role="dialog" aria-modal="true">Other dialog</div>}</>;
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("waits exactly the default two minutes and does not reset on unrelated renders", async () => {
  const view = render(<Harness />);
  await advance(IDLE_COVER_DELAY_MS - 1);
  view.rerender(<Harness />);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  await advance(1);
  expect(screen.getByLabelText("Phase").textContent).toBe("visible");
  fireEvent.pointerMove(window);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
});

it("local activity restarts the deadline without a render per movement", async () => {
  render(<Harness />);
  await advance(IDLE_COVER_DELAY_MS - 1000);
  fireEvent.pointerMove(window);
  await advance(1000);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  await advance(IDLE_COVER_DELAY_MS - 1000);
  expect(screen.getByLabelText("Phase").textContent).toBe("visible");
});

it("disabled, paused and modal states cannot enter; resuming starts a full new period", async () => {
  const view = render(<Harness enabled={false} />);
  await advance(600000);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  view.rerender(<Harness eligible={false} />);
  await advance(600000);
  view.rerender(<Harness />);
  await advance(IDLE_COVER_DELAY_MS - 1);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  view.rerender(<Harness modal />);
  await act(async () => {});
  await advance(600000);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  view.rerender(<Harness />);
  await act(async () => {});
  await advance(IDLE_COVER_DELAY_MS);
  expect(screen.getByLabelText("Phase").textContent).toBe("visible");
});

it("the first click wakes without activating an underlying button, even with instant exit", async () => {
  render(<Harness />);
  await advance(IDLE_COVER_DELAY_MS);
  const button = screen.getByRole("button");
  fireEvent.pointerDown(button, { pointerId: 1 });
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button);
  expect(button.textContent).toBe("Underlying 0");
  fireEvent.pointerDown(button, { pointerId: 1 });
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button);
  expect(button.textContent).toBe("Underlying 1");
});

it("wake keys and autorepeat never reach transport handlers until released", async () => {
  render(<Harness />);
  const transport = vi.fn();
  window.addEventListener("keydown", transport);
  await advance(IDLE_COVER_DELAY_MS);
  fireEvent.keyDown(window, { code: "Space", key: " " });
  fireEvent.keyDown(window, { code: "Space", key: " ", repeat: true });
  expect(transport).not.toHaveBeenCalled();
  fireEvent.keyUp(window, { code: "Space", key: " " });
  fireEvent.keyDown(window, { code: "Space", key: " " });
  expect(transport).toHaveBeenCalledOnce();
  window.removeEventListener("keydown", transport);
});

it("blur and library switches dismiss and invalidate the old deadline", async () => {
  const view = render(<Harness />);
  await advance(IDLE_COVER_DELAY_MS);
  fireEvent.blur(window);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  await advance(600000);
  fireEvent.focus(window);
  await advance(IDLE_COVER_DELAY_MS - 1);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  view.rerender(<Harness scopeKey={1} />);
  await advance(1);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not cover a held pointer or an active drag", async () => {
  render(<Harness />);
  fireEvent.pointerDown(window, { pointerId: 1 });
  await advance(300001);
  expect(screen.getByLabelText("Phase").textContent).toBe("hidden");
  fireEvent.pointerUp(window, { pointerId: 1 });
  await advance(IDLE_COVER_DELAY_MS);
  expect(screen.getByLabelText("Phase").textContent).toBe("visible");
});

it("installs no activity listeners or observer while disabled and removes them on disable", async () => {
  const listen = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const observe = vi.spyOn(MutationObserver.prototype, "observe");
  const view = render(<Harness enabled={false} />);
  expect(listen.mock.calls.filter(([name]) => name === "wheel")).toHaveLength(0);
  expect(observe).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  expect(observe).toHaveBeenCalledOnce();
  expect(listen.mock.calls.filter(([name]) => name === "wheel")).toHaveLength(1);
  view.rerender(<Harness enabled={false} />);
  expect(remove.mock.calls.filter(([name]) => name === "wheel")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
