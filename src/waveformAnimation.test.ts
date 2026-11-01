import { expect, it, vi } from "vitest";
import { createWaveformAnimation } from "./waveformAnimation";

function environment() {
  let next = 0;
  let visible = true;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    request: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancel: (id: number) => { frames.delete(id); }, visible: () => visible,
    setVisible: (value: boolean) => { visible = value; },
    frames, tick: (now: number) => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now)); },
  };
}

it("stops scheduling after a static frame and coalesces invalidations", () => {
  const env = environment();
  const paint = vi.fn(() => false);
  const animation = createWaveformAnimation(paint, env);
  animation.invalidate(); animation.invalidate(); animation.invalidate();
  expect(env.frames.size).toBe(1);
  env.tick(0);
  expect(paint).toHaveBeenCalledOnce();
  expect(env.frames.size).toBe(0);
  animation.invalidate();
  env.tick(40);
  expect(paint).toHaveBeenCalledTimes(2);
  expect(env.frames.size).toBe(0);
});

it("limits motion to 30Hz, cancels hidden work and resumes only on invalidation", () => {
  const env = environment();
  const paint = vi.fn(() => true);
  const animation = createWaveformAnimation(paint, env);
  animation.invalidate(); env.tick(0); env.tick(16); env.tick(34);
  expect(paint).toHaveBeenCalledTimes(2);
  env.setVisible(false); animation.invalidate();
  expect(env.frames.size).toBe(0);
  env.setVisible(true); animation.invalidate(); env.tick(100);
  expect(paint).toHaveBeenCalledTimes(3);
  animation.dispose(); animation.invalidate();
  expect(env.frames.size).toBe(0);
});
