/* Offline analysis: the renderer and the music share the AudioContext clock. */
(() => {
  "use strict";
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

  function analyze(buffer, duration = buffer.duration) {
    const rate = buffer.sampleRate;
    const samples = Math.min(buffer.length, Math.floor(duration * rate));
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const hop = Math.round(rate / 100);
    const frames = Math.ceil(samples / hop);
    const energy = new Float32Array(frames);
    const bass = new Float32Array(frames);
    const onset = new Float32Array(frames);
    const waveform = new Float32Array(1200);
    const coefficient = 1 - Math.exp(-2 * Math.PI * 160 / rate);
    let low = 0;
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0, lowSum = 0;
      const end = Math.min(samples, (frame + 1) * hop);
      for (let i = frame * hop; i < end; i++) {
        let sample = 0;
        for (const channel of channels) sample += channel[i] / channels.length;
        low += coefficient * (sample - low);
        sum += sample * sample;
        lowSum += low * low;
        const bin = Math.min(1199, Math.floor(i / samples * 1200));
        waveform[bin] = Math.max(waveform[bin], Math.abs(sample));
      }
      energy[frame] = Math.sqrt(sum / hop);
      bass[frame] = Math.sqrt(lowSum / hop);
      if (frame > 2) onset[frame] = Math.max(0, energy[frame] - energy[frame - 3])
        + 1.6 * Math.max(0, bass[frame] - bass[frame - 3]);
    }
    const normalize = (array) => {
      const sorted = [...array].sort((a, b) => a - b);
      const reference = sorted[Math.floor(sorted.length * 0.97)] || 1;
      for (let i = 0; i < array.length; i++) array[i] = clamp(array[i] / reference);
    };
    normalize(energy); normalize(bass); normalize(onset); normalize(waveform);

    // Cache a small FFT at video frame rate: deterministic in preview and offline export.
    const spectra = new Uint8Array(Math.ceil(duration * 30) * 128);
    const real = new Float32Array(256), imaginary = new Float32Array(256);
    const reverse = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i, reversed = 0;
      for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (value & 1); value >>= 1; }
      reverse[i] = reversed;
    }
    for (let frame = 0; frame < Math.ceil(duration * 30); frame++) {
      const start = Math.floor(frame / 30 * rate);
      imaginary.fill(0);
      for (let i = 0; i < 256; i++) {
        let sample = 0;
        for (const channel of channels) sample += (channel[start + i] || 0) / channels.length;
        real[reverse[i]] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / 255));
      }
      for (let size = 2; size <= 256; size *= 2) {
        const half = size / 2;
        for (let offset = 0; offset < 256; offset += size) for (let i = 0; i < half; i++) {
          const angle = -2 * Math.PI * i / size, cosine = Math.cos(angle), sine = Math.sin(angle);
          const a = offset + i, b = a + half;
          const r = real[b] * cosine - imaginary[b] * sine;
          const im = real[b] * sine + imaginary[b] * cosine;
          real[b] = real[a] - r; imaginary[b] = imaginary[a] - im;
          real[a] += r; imaginary[a] += im;
        }
      }
      for (let bin = 0; bin < 128; bin++) {
        const decibels = 20 * Math.log10(Math.max(1e-8, Math.hypot(real[bin], imaginary[bin]) / 128));
        const value = clamp((decibels + 85) / 65) * 255;
        const previous = frame > 0 ? spectra[(frame - 1) * 128 + bin] : 0;
        spectra[frame * 128 + bin] = Math.round(value * 0.45 + previous * 0.55);
      }
    }

    const peaks = [];
    for (let i = 2; i < frames - 2; i++) {
      if (onset[i] < 0.27 || onset[i] < onset[i - 1] || onset[i] < onset[i + 1]) continue;
      const previous = peaks[peaks.length - 1];
      if (previous && i / 100 - previous.time < 0.18) {
        if (onset[i] > previous.strength) peaks[peaks.length - 1] = { time: i / 100, strength: onset[i] };
      } else peaks.push({ time: i / 100, strength: onset[i] });
    }

    // Autocorrelation of positive energy differences, with octave support.
    let bestScore = -Infinity, bpm = 100;
    const correlation = (lag) => {
      let sum = 0;
      for (let i = Math.ceil(lag); i < frames; i++) {
        const source = i - lag, floor = Math.floor(source), fraction = source - floor;
        sum += onset[i] * (onset[floor] * (1 - fraction) + (onset[floor + 1] || 0) * fraction);
      }
      return sum / Math.max(1, frames - lag);
    };
    for (let candidate = 80; candidate <= 155; candidate += 0.25) {
      const lag = 6000 / candidate;
      const score = correlation(lag) + correlation(lag * 2) * 0.5 + correlation(lag * 4) * 0.25;
      if (score > bestScore) { bestScore = score; bpm = candidate; }
    }
    const period = 60 / bpm;
    let phase = 0, phaseScore = -Infinity;
    for (let offset = 0; offset < period; offset += 0.01) {
      let score = 0;
      for (let t = offset; t < duration; t += period) {
        const i = Math.round(t * 100);
        score += (onset[i] || 0) + (onset[i + 1] || 0) * 0.5;
      }
      if (score > phaseScore) { phaseScore = score; phase = offset; }
    }
    const snap = (target) => {
      const nearby = peaks.filter((peak) => Math.abs(peak.time - target) <= 0.55);
      if (!nearby.length) return clamp(phase + Math.round((target - phase) / period) * period, target - 0.5, target + 0.5);
      return nearby.reduce((best, peak) =>
        peak.strength - Math.abs(peak.time - target) * 0.65 > best.strength - Math.abs(best.time - target) * 0.65 ? peak : best).time;
    };
    return { energy, bass, onset, waveform, spectra, peaks, bpm, phase, period,
      cuts: [0, ...[4.5, 10, 21, 32, 44, 55, 66, 74].map((time) => snap(time * duration / 79.5)), duration] };
  }

  function sample(analysis, time) {
    const i = Math.max(0, Math.floor(time * 100));
    let hit = 0;
    for (let j = 0; j < 25 && j <= i; j++) hit = Math.max(hit, (analysis.onset[i - j] || 0) * Math.exp(-j / 6));
    const phase = ((time - analysis.phase) / analysis.period % 1 + 1) % 1;
    return { energy: analysis.energy[i] || 0, bass: analysis.bass[i] || 0, hit,
      beat: Math.exp(-phase * 13), index: Math.floor((time - analysis.phase) / analysis.period) };
  }
  window.PromoAudioAnalysis = { analyze, sample };
})();
