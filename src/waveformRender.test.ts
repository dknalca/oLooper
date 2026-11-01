// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderWaveform, waveformWindowStart } from "./waveformRender";
import type { PlayerStatus, WaveformData } from "./tauri";

it("centers a zoom window and clamps it at the track boundaries", () => {
  expect(waveformWindowStart(500, 1000, 1000)).toBe(0);
  expect(waveformWindowStart(500, 1000, 200)).toBe(400);
  expect(waveformWindowStart(0, 1000, 200)).toBe(0);
  expect(waveformWindowStart(1000, 1000, 200)).toBe(800);
});

it("draws preview boundaries, visible CUEs and the playhead at the zoomed coordinates", () => {
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), fillStyle: "", strokeStyle: "", lineWidth: 0, font: "" };
  const canvas = { clientWidth: 100, clientHeight: 40, width: 0, height: 0, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement;
  const wave: WaveformData = { peaks: [0.5, 0.8], buckets: 2, duration_ms: 1000 };
  const status = { loop_enabled: true, loop_start_ms: 0, loop_end_ms: 1000 } as PlayerStatus;
  renderWaveform(canvas, wave, status, 500, [{ slot: 2, label: "CUE", position_ms: 500 }], 2, { start: 300, end: 700 }, true);
  expect(ctx.moveTo).toHaveBeenCalledWith(10, 0);
  expect(ctx.moveTo).toHaveBeenCalledWith(90, 0);
  expect(ctx.fillText).toHaveBeenCalledWith("2", 53, 11);
  expect(ctx.fillRect).toHaveBeenCalledWith(49, 0, 2, 40);
});
