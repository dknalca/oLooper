import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const sandbox = { window: {} };
vm.runInNewContext(await readFile(new URL("audio-analysis.js", import.meta.url), "utf8"), sandbox);
const { analyze, sample } = sandbox.window.PromoAudioAnalysis;

function fixture(seconds, bpm, silent = false) {
  const sampleRate = 8000, length = seconds * sampleRate;
  const data = new Float32Array(length);
  if (!silent) {
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const sinceBeat = t % (60 / bpm);
      data[i] = Math.sin(2 * Math.PI * 90 * sinceBeat) * Math.exp(-sinceBeat * 35) * 0.8;
    }
  }
  return { duration: seconds, sampleRate, length, numberOfChannels: 1, getChannelData: () => data };
}

test("detects a known tempo and places narrative cuts near measured attacks", () => {
  const result = analyze(fixture(20, 120));
  assert.ok(Math.abs(result.bpm - 120) <= 1, `Estimated ${result.bpm} BPM`);
  assert.equal(result.cuts.length, 10);
  assert.equal(result.cuts[0], 0);
  assert.equal(result.cuts.at(-1), 20);
  assert.ok(result.peaks.length >= 35);
  assert.equal(result.spectra.length, 20 * 30 * 128);
  assert.ok(result.spectra.some((value) => value > 0));
  for (let i = 1; i < result.cuts.length - 1; i++) {
    assert.ok(result.cuts[i] > result.cuts[i - 1]);
    assert.ok(result.peaks.some((peak) => Math.abs(peak.time - result.cuts[i]) < 0.02));
  }
  const peak = result.peaks[8];
  assert.ok(sample(result, peak.time + 0.01).hit > sample(result, peak.time + 0.3).hit);
});

test("silence and end-of-track samples remain finite and bounded", () => {
  const result = analyze(fixture(20, 120, true));
  assert.equal(result.peaks.length, 0);
  assert.ok(result.waveform.every((value) => value === 0));
  assert.ok(result.spectra.every((value) => value === 0));
  for (const time of [0, 19.999, 20, 30]) {
    for (const [key, value] of Object.entries(sample(result, time))) {
      assert.ok(Number.isFinite(value), key);
      if (key !== "index") assert.ok(value >= 0 && value <= 1, key);
    }
  }
  assert.ok(result.cuts.every(Number.isFinite));
});
