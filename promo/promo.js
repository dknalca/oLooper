(() => {
  "use strict";
  const W = 1920, H = 1080;
  let duration = 79.5;
  const BLUE = "#5bb8ff", MINT = "#bfff71", WHITE = "#f2f4ee", MUTED = "#8c9bad";
  const $ = (id) => document.getElementById(id);
  const canvas = $("promo-canvas"), ctx = canvas.getContext("2d", { alpha: false });
  const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
  const mix = (a, b, t) => a + (b - a) * t;
  const ease = (t) => 1 - (1 - clamp(t)) ** 3;
  const assets = {};
  const state = { context: null, buffer: null, analysis: null, source: null, recorder: null,
    stream: null, running: false, recording: false, starting: false, time: 0, start: 0, raf: 0, url: null };
  let musicBytes = null;
  const spectrum = new Uint8Array(128);
  const chapterNames = ["IDENTIDAD", "DALE PLAY", "IMPORTA", "ORGANIZA", "VISUALIZA", "PRACTICA", "CONECTA", "TU SESIÓN", "oLooper"];

  function rect(x, y, w, h, color, radius = 0, stroke = null) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
    if (color) { ctx.fillStyle = color; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  function text(value, x, y, size, color = WHITE, weight = 700, align = "left") {
    ctx.font = `${weight} ${size}px "Arial", sans-serif`;
    ctx.textAlign = align; ctx.textBaseline = "alphabetic"; ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }
  function line(x1, y1, x2, y2, color, width = 1) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  function circle(x, y, r, color, stroke = null) {
    ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
    if (color) { ctx.fillStyle = color; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  function image(url) {
    return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`No se pudo cargar ${url}`)); img.src = url;
    });
  }
  function texture(img, crop, width = 1600) {
    const target = document.createElement("canvas");
    target.width = width; target.height = Math.round(width * crop[3] / crop[2]);
    target.getContext("2d").drawImage(img, ...crop, 0, 0, target.width, target.height);
    return target;
  }
  const assetsReady = Promise.all([
    image("../docs/screenshots/Main.png"), image("../docs/screenshots/Midi.png"),
    image("../docs/screenshots/Importar.png"), image("../src-tauri/icons/icon.png"),
  ]).then(([main, midi, imports, logo]) => {
    assets.main = texture(main, [112, 76, 2400, 1500]);
    assets.library = texture(main, [135, 650, 2360, 900]);
    assets.transport = texture(main, [135, 500, 2360, 125]);
    assets.imports = texture(imports, [1000, 557, 625, 600], 700);
    assets.midi = texture(midi, [765, 218, 1090, 1270], 900);
    assets.logo = logo;
  });
  // Attach a handler immediately, including when the page is opened via file://.
  assetsReady.catch((error) => { $("message").textContent = `${error.message}. Abre la promo con el servidor local (ver guion.md).`; });
  const musicReady = location.protocol === "file:" ? Promise.resolve(null)
    : fetch("FreeScratch.mp3").then((response) => {
      if (!response.ok) throw new Error("No se encuentra FreeScratch.mp3");
      return response.arrayBuffer();
    }).then((bytes) => { musicBytes = bytes; return bytes; }).catch(() => null);

  // A planar mesh with true perspective projection, rendered as affine triangles.
  function panel(img, cx, cy, width, yaw = 0, pitch = 0, roll = 0, alpha = 1) {
    if (!img || alpha <= 0) return;
    const height = width * img.height / img.width;
    const project = (u, v) => {
      const x = (u - 0.5) * width, y = (v - 0.5) * height;
      const xx = x * Math.cos(yaw), zz = -x * Math.sin(yaw);
      const yy = y * Math.cos(pitch) - zz * Math.sin(pitch);
      const z = y * Math.sin(pitch) + zz * Math.cos(pitch);
      const scale = 2400 / (2400 + z);
      return [cx + (xx * Math.cos(roll) - yy * Math.sin(roll)) * scale,
        cy + (xx * Math.sin(roll) + yy * Math.cos(roll)) * scale];
    };
    ctx.save(); ctx.globalAlpha *= alpha;
    const corners = [project(0, 0), project(1, 0), project(1, 1), project(0, 1)];
    ctx.beginPath(); corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.shadowColor = "#000"; ctx.shadowBlur = 55; ctx.shadowOffsetY = 28;
    ctx.fillStyle = "#121b26"; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    const nx = 12, ny = 4;
    for (let row = 0; row < ny; row++) for (let col = 0; col < nx; col++) {
      const u = col / nx, v = row / ny, du = 1 / nx, dv = 1 / ny;
      const a = project(u, v), b = project(u + du, v), c = project(u, v + dv), d = project(u + du, v + dv);
      triangle(img, [u, v], [u + du, v], [u, v + dv], a, b, c);
      triangle(img, [u + du, v + dv], [u, v + dv], [u + du, v], d, c, b);
    }
    ctx.beginPath(); corners.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.strokeStyle = "#425570"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  }
  function triangle(img, uv0, uv1, uv2, p0, p1, p2) {
    const sx0 = uv0[0] * img.width, sy0 = uv0[1] * img.height;
    const sx1 = uv1[0] * img.width - sx0, sy1 = uv1[1] * img.height - sy0;
    const sx2 = uv2[0] * img.width - sx0, sy2 = uv2[1] * img.height - sy0;
    const det = sx1 * sy2 - sx2 * sy1;
    const dx1 = p1[0] - p0[0], dy1 = p1[1] - p0[1], dx2 = p2[0] - p0[0], dy2 = p2[1] - p0[1];
    const a = (dx1 * sy2 - dx2 * sy1) / det, b = (dy1 * sy2 - dy2 * sy1) / det;
    const c = (dx2 * sx1 - dx1 * sx2) / det, d = (dy2 * sx1 - dy1 * sx2) / det;
    ctx.save(); ctx.beginPath();
    // Expand the clipping triangle slightly to prevent antialiased mesh seams.
    const center = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3];
    [p0, p1, p2].forEach((p, i) => {
      const dx = p[0] - center[0], dy = p[1] - center[1], length = Math.hypot(dx, dy) || 1;
      const x = p[0] + dx / length * 0.65, y = p[1] + dy / length * 0.65;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, d, p0[0] - a * sx0 - c * sy0, p0[1] - b * sx0 - d * sy0);
    const left = Math.max(0, Math.min(uv0[0], uv1[0], uv2[0]) * img.width - 1);
    const top = Math.max(0, Math.min(uv0[1], uv1[1], uv2[1]) * img.height - 1);
    const right = Math.min(img.width, Math.max(uv0[0], uv1[0], uv2[0]) * img.width + 1);
    const bottom = Math.min(img.height, Math.max(uv0[1], uv1[1], uv2[1]) * img.height + 1);
    ctx.drawImage(img, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
    ctx.restore();
  }

  function background(t, audio, bright = false) {
    rect(0, 0, W, H, bright ? "#dbe8cf" : "#080c11");
    if (bright) return;
    const gradient = ctx.createRadialGradient(1250, 500, 0, 1250, 500, 1100);
    gradient.addColorStop(0, `rgba(31,75,104,${0.14 + audio.bass * 0.12})`); gradient.addColorStop(1, "#080c1100");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 70; i++) {
      const x = (i * 271.7 + t * (1 + i % 4)) % W;
      const y = (i * 167.3) % H;
      circle(x, y, i % 7 === 0 ? 2 : 0.8, `rgba(157,196,219,${0.08 + audio.hit * 0.14})`);
    }
    for (let i = 0; i < 4; i++) line(120 + i * 560, 0, 120 + i * 560, H, "#d4e5ef05");
  }
  function heading(kicker, first, second, local, color = WHITE, x = 115, y = 255, size = 94) {
    const reveal = ease(local / 0.7);
    ctx.save(); ctx.globalAlpha *= reveal; ctx.translate(0, (1 - reveal) * 55);
    text(kicker, x, y - 70, 14, color === WHITE ? MINT : "#45623f", 500);
    text(first, x, y + 20, size, color, 750);
    if (second) text(second, x, y + 20 + size * 1.04, size, color, 750);
    ctx.restore();
  }
  function pill(value, x, y, color = MINT) {
    ctx.font = '500 16px Arial'; const width = ctx.measureText(value).width + 40;
    rect(x, y, width, 44, "#101820", 22, "#3a4b57"); text(value, x + 20, y + 28, 16, color, 500);
    return width;
  }
  function ring(t, audio, cx, cy, radius) {
    for (let i = 0; i < 96; i++) {
      const angle = i / 96 * Math.PI * 2 + t * 0.07;
      const value = spectrum[i] / 255 || audio.energy * (0.3 + Math.abs(Math.sin(i * 0.7 + t)) * 0.55);
      const inner = radius + audio.hit * 8;
      const outer = inner + 8 + value * 115;
      line(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer, i % 8 === 0 ? MINT : BLUE, 3);
    }
    circle(cx, cy, radius - 15, null, "#6bbcff25");
  }
  function waveform(t, audio, x, y, width, height, windowSeconds = 10) {
    const data = state.analysis?.waveform;
    for (let i = 0; i < 220; i++) {
      const second = (t + i / 220 * windowSeconds) % duration;
      const value = data ? data[Math.floor(second / duration * data.length)] : Math.abs(Math.sin(i * 0.15) * Math.cos(i * 0.07));
      const amplitude = (8 + value * height) * (0.88 + audio.bass * 0.12);
      rect(x + i * width / 220, y - amplitude / 2, width / 220 * 0.55, amplitude, i < 60 ? BLUE : i < 140 ? MINT : "#355263", 2);
    }
  }

  function scene(index, local, length, t, a) {
    const p = clamp(local / length), arrival = ease(local / 0.8);
    if (index === 0) {
      // Show the actual product from frame zero, before the copy finishes entering.
      panel(assets.main, 1380 - p * 15, 545, 990 + p * 35, -0.16 + p * 0.1, 0.035, -0.025);
      heading("oLooper / PARA QUIENES VIVEN EL SCRATCH", "Todo empieza", "con un loop.", local, WHITE, 115, 350, 94);
      text("Dale espacio a tu próxima sesión.", 120, 735, 25, MUTED, 400);
    } else if (index === 1) {
      const words = ["IMPORTA.", "ENCUENTRA.", "DALE PLAY."];
      const firstBeat = state.analysis ? Math.floor((t - local - state.analysis.phase) / state.analysis.period) : 0;
      const selected = Math.min(2, Math.max(0, Math.floor((a.index - firstBeat) / 3)));
      panel(assets.main, 1380 - p * 20, 545, 990 + p * 35, -0.06 + p * 0.12, 0.02, -0.012);
      words.forEach((word, i) => text(word, 115, 340 + i * 145, 94, i === selected ? MINT : "#53616a", 750));
    } else if (index === 2) {
      heading("01 / RECUPERA TU COLECCIÓN", "Tus loopers.", "Nueva vida.", local, WHITE, 115, 350, 103);
      text("SWF / EXE + tus archivos de audio.", 120, 680, 25, MUTED, 400);
      pill("IMPORTACIÓN LOCAL", 120, 736);
      panel(assets.main, 1390 - p * 35, 545, 1080, -0.28 + p * 0.15, 0.07, -0.035);
      panel(assets.imports, 1210, 570 + (1 - arrival) * 140, 410, 0.14 - p * 0.1, 0, 0.025);
    } else if (index === 3) {
      heading("02 / UNA BIBLIOTECA. TU CRITERIO.", "Menos buscar.", "Más tocar.", local, "#0a2017", 115, 225, 87);
      text("Colecciones. Favoritos. Playlists.", 120, 490, 24, "#45623f", 400);
      panel(assets.library, 1210, 655 - p * 20, 1270 + p * 60, 0.12 - p * 0.1, -0.06, -0.035);
      circle(270, 770, 90, "#1b3527"); text("♪", 270, 797, 84, MINT, 500, "center");
    } else if (index === 4) {
      heading("03 / MIRA EL SONIDO", "Siente cada detalle.", "", local, WHITE, 115, 240, 105);
      rect(110, 387, 1700, 415, "#111b23", 22, "#304653");
      rect(610, 407, 550, 375, "#bfff7108", 10, "#bfff7140");
      text("FREE SCRATCH", 145, 435, 14, MUTED, 500);
      text("FORMA DE ONDA / AUDIO REAL", 1775, 435, 14, MINT, 500, "right");
      waveform(t, a, 150, 605, 1620, 245);
      const playhead = 150 + ((t / (state.analysis?.period || 0.6) / 16) % 1) * 1620;
      line(playhead, 462, playhead, 765, WHITE, 2); circle(playhead, 463, 5, WHITE);
      const labelWidth = 240, labelGap = 24;
      const labelLeft = (W - (3 * labelWidth + 2 * labelGap)) / 2;
      ["FORMA DE ONDA", "BPM", "CUES"].forEach((value, i) => {
        const x = labelLeft + i * (labelWidth + labelGap);
        rect(x, 850, labelWidth, 48, "#101820", 24, "#3a4b57");
        text(value, x + labelWidth / 2, 881, 16, i === 1 ? BLUE : MINT, 500, "center");
      });
    } else if (index === 5) {
      heading("04 / LA REPETICIÓN ES EL CAMINO", "Tu tempo.", "Tu progreso.", local, WHITE, 115, 300, 106);
      text("Pitch en vivo. Loop. Metrónomo.", 120, 630, 25, MUTED, 400);
      panel(assets.transport, 950, 820, 1680, -0.02, 0.11, -0.01);
      const cx = 1450, cy = 420;
      circle(cx, cy, 185, "#101a20", "#324851");
      for (let i = 0; i < 64; i++) {
        const angle = (-225 + i * 4.7) * Math.PI / 180;
        line(cx + Math.cos(angle) * 160, cy + Math.sin(angle) * 160,
          cx + Math.cos(angle) * 174, cy + Math.sin(angle) * 174, i < 35 + Math.sin(p * 6) * 9 ? MINT : "#30424c", 3);
      }
      text(`${Math.round(100 - 4 * Math.sin(p * Math.PI))}%`, cx, cy + 15, 76, WHITE, 700, "center");
      text("PITCH / SPEED", cx, cy + 65, 13, MINT, 500, "center");
      for (let i = 0; i < 4; i++) circle(1390 + i * 40, 672, 8, ((a.index % 4) + 4) % 4 === i ? MINT : "#30424c");
    } else if (index === 6) {
      heading("05 / CONECTA CON TU SESIÓN", "Tus manos.", "El control.", local, WHITE, 115, 320, 108);
      text("Asigna tus acciones con MIDI.", 120, 650, 25, MUTED, 400);
      panel(assets.midi, 1450 - p * 50, 535, 620, -0.16 + p * 0.18, 0.035, 0.025);
      for (let i = 0; i < 4; i++) {
        const active = ((a.index % 4) + 4) % 4 === i;
        rect(120 + i * 112, 730, 90, 84, active ? MINT : "#16252e", 13, active ? MINT : "#3c515b");
        text(String(i + 1), 165 + i * 112, 785, 28, active ? "#12231a" : MUTED, 700, "center");
      }
    } else if (index === 7) {
      text("PREPARA TU PRÓXIMA SESIÓN", 960, 170, 16, MINT, 500, "center");
      panel(assets.main, 960, 590, 1150 + p * 40, mix(-0.12, 0.02, p), -0.04, mix(-0.03, 0, p));
    } else {
      ring(t, a, 960, 365, 142);
      text("oLooper", 960, 660, 154, WHITE, 750, "center");
      text("TU COLECCIÓN. TU RITMO.", 960, 740, 27, MINT, 500, "center");
      text("DALE PLAY A TU MANERA.", 960, 800, 18, MUTED, 500, "center");
    }
  }

  function draw(time) {
    const cuts = state.analysis?.cuts || [0, 4.5, 10, 21, 32, 44, 55, 66, 74, duration];
    const index = Math.max(0, Math.min(8, cuts.findIndex((cut, i) => i > 0 && time < cut) - 1));
    const sceneIndex = time >= duration ? 8 : index;
    const local = time - cuts[sceneIndex];
    const a = state.analysis ? window.PromoAudioAnalysis.sample(state.analysis, time) : { energy: 0.24, bass: 0, hit: 0, beat: 0, index: 0 };
    if (state.analysis) {
      const frame = Math.min(Math.floor(time * 30), state.analysis.spectra.length / 128 - 1);
      spectrum.set(state.analysis.spectra.subarray(frame * 128, (frame + 1) * 128));
    } else spectrum.fill(0);
    const bright = sceneIndex === 3;
    background(time, a, bright);
    ctx.save();
    // Small impact, driven by measured transients, rather than arbitrary shaking.
    const zoom = 1 + a.hit * 0.004;
    ctx.translate(W / 2, H / 2); ctx.scale(zoom, zoom); ctx.translate(-W / 2, -H / 2);
    scene(sceneIndex, local, cuts[sceneIndex + 1] - cuts[sceneIndex], time, a);
    ctx.restore();
    // A brief black shutter gives each cut a deliberate, beat-aligned reveal.
    if (sceneIndex > 0 && local < 0.16) rect(0, 0, W, H, `rgba(4,8,10,${(1 - local / 0.16) * 0.8})`);
    if (time > duration - 0.8) rect(0, 0, W, H, `rgba(4,8,10,${clamp((time - duration + 0.8) / 0.8)})`);
    $("timecode").textContent = `${format(time)} / ${format(duration)}`;
    $("timeline").value = time;
    $("chapter").textContent = chapterNames[sceneIndex];
  }
  function format(t) { return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`; }
  function controls() {
    $("preview").textContent = state.running ? "Ⅱ Pausar" : state.time > 0 && state.time < duration ? "▶ Continuar" : "▶ Reproducir";
    $("preview").disabled = state.starting || state.recording;
    $("export").disabled = state.running || state.starting;
    $("timeline").disabled = state.recording || state.starting;
    $("music-file").disabled = state.running || state.starting;
    $("stop").disabled = state.starting;
  }
  async function prepare() {
    await assetsReady;
    if (!state.context) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error("Este navegador no soporta Web Audio.");
      state.context = new Audio();
    }
    await state.context.resume();
    if (state.buffer) return;
    await musicReady;
    if (!musicBytes) {
      $("file-label").hidden = false;
      throw new Error("Selecciona FreeScratch.mp3 con «Cargar música» o abre http://localhost:4173/promo/ usando node promo/serve.mjs.");
    }
    $("status").textContent = "Analizando el ritmo…";
    state.buffer = await state.context.decodeAudioData(musicBytes.slice(0));
    if (state.buffer.duration < 10) { state.buffer = null; throw new Error("La música debe durar al menos 10 segundos."); }
    duration = state.buffer.duration;
    $("timeline").max = duration;
    state.analysis = window.PromoAudioAnalysis.analyze(state.buffer, duration);
    $("audio-info").textContent = `FreeScratch · ≈${Math.round(state.analysis.bpm)} BPM · cortes sincronizados`;
  }
  function mime() {
    if (!window.MediaRecorder || !canvas.captureStream) return null;
    return ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/mp4", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
  }
  function connectAudio(offset) {
    const context = state.context, source = context.createBufferSource(), gain = context.createGain();
    const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.72;
    const destination = context.createMediaStreamDestination();
    const monitor = context.createGain(); monitor.gain.value = $("mute").checked ? 0 : 1;
    source.buffer = state.buffer; source.connect(gain); gain.connect(analyser);
    analyser.connect(monitor); monitor.connect(context.destination); analyser.connect(destination);
    const when = context.currentTime + 0.08;
    gain.gain.setValueAtTime(offset < 0.06 ? 0 : 0.88, when);
    if (offset < 0.06) gain.gain.linearRampToValueAtTime(0.88, when + 0.06);
    // Preserve the complete track; only soften the final edge, not its musical ending.
    gain.gain.setValueAtTime(0.88, when + Math.max(0, duration - 0.15 - offset));
    gain.gain.linearRampToValueAtTime(0, when + duration - offset);
    state.source = source; state.gain = gain; state.analyser = analyser; state.destination = destination; state.monitor = monitor;
    state.start = when - offset;
    return { source, when, stream: destination.stream };
  }
  function releaseAudio() {
    if (state.source) { try { state.source.stop(); } catch { /* Already ended. */ } }
    if (!state.recording) state.destination?.stream.getTracks().forEach((track) => track.stop());
    for (const key of ["source", "gain", "analyser", "monitor", "destination"]) {
      state[key]?.disconnect(); state[key] = null;
    }
  }
  function tick() {
    if (!state.running) return;
    state.time = clamp(state.context.currentTime - state.start, 0, duration);
    draw(state.time);
    if (state.time >= duration) { finish(); return; }
    state.raf = requestAnimationFrame(tick);
  }
  async function begin(recording) {
    if (state.starting || state.recording) return;
    if (state.running) { pause(); return; }
    state.starting = true; controls(); $("download").hidden = true;
    try {
      if (recording && !mime()) throw new Error("La exportación requiere un navegador compatible con MediaRecorder, como Chrome o Firefox.");
      await prepare();
      const offset = recording || state.time >= duration ? 0 : state.time;
      const audio = connectAudio(offset);
      if (recording) {
        const type = mime();
        state.stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audio.stream.getAudioTracks()]);
        const recorder = new MediaRecorder(state.stream, { mimeType: type, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 256_000 });
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = () => {
          state.stream?.getTracks().forEach((track) => track.stop()); state.stream = null;
          if (!state.cancelled) {
            if (state.url) URL.revokeObjectURL(state.url);
            state.url = URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType }));
            const link = $("download"); link.href = state.url;
            link.download = `oLooper-FreeScratch.${recorder.mimeType.includes("mp4") ? "mp4" : "webm"}`;
            link.hidden = false; link.click();
            $("message").textContent = "Video listo con FreeScratch integrado. Puedes volver a descargarlo aquí.";
            $("status").textContent = "Exportación completada";
          }
          state.recording = false; state.recorder = null; controls();
        };
        recorder.onerror = () => {
          state.cancelled = true; finish(true);
          $("message").textContent = "El navegador interrumpió la grabación. Vuelve a exportar con esta pestaña visible.";
        };
        state.cancelled = false; state.recording = true; state.recorder = recorder;
        draw(0); recorder.start(1000);
      }
      state.time = offset; state.running = true; state.starting = false;
      audio.source.start(audio.when, offset, duration - offset);
      $("status").textContent = recording ? "● Grabando · 1080p / 30 fps" : "Reproduciendo · audio sincronizado";
      $("message").textContent = recording ? `Exportando en tiempo real. Mantén esta pestaña visible durante ${Math.ceil(duration)} segundos.` : "La música dirige los cortes, las formas de onda y los acentos visuales.";
      controls(); tick();
    } catch (error) {
      state.starting = false; state.cancelled = true;
      if (state.recorder?.state === "recording") state.recorder.stop();
      if (!state.recorder) { state.stream?.getTracks().forEach((track) => track.stop()); state.stream = null; }
      releaseAudio(); state.running = false; controls();
      $("status").textContent = "No se pudo iniciar"; $("message").textContent = error.message;
    }
  }
  function pause() {
    state.running = false; cancelAnimationFrame(state.raf); releaseAudio(); controls();
    $("status").textContent = "En pausa";
  }
  function finish(cancelled = false) {
    state.cancelled = cancelled; state.running = false; cancelAnimationFrame(state.raf);
    if (state.recorder?.state === "recording") state.recorder.stop();
    releaseAudio();
    if (!state.recording) $("status").textContent = cancelled ? "Detenido" : "Vista previa terminada";
    controls();
  }
  $("preview").addEventListener("click", () => begin(false));
  $("export").addEventListener("click", () => begin(true));
  $("stop").addEventListener("click", () => { finish(true); state.time = 0; draw(0); controls(); });
  $("timeline").addEventListener("input", () => { if (state.running) pause(); state.time = Number($("timeline").value); draw(state.time); controls(); });
  $("mute").addEventListener("change", () => {
    if (state.monitor) state.monitor.gain.value = $("mute").checked ? 0 : 1;
  });
  $("fullscreen").addEventListener("click", () => {
    const request = canvas.requestFullscreen || canvas.webkitRequestFullscreen;
    if (request) { const result = request.call(canvas); result?.catch(() => {}); }
  });
  $("music-file").addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    musicBytes = await file.arrayBuffer(); state.buffer = null; state.analysis = null;
    $("message").textContent = `Música cargada: ${file.name}. Pulsa Reproducir para analizarla.`;
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || !state.running) return;
    if (state.recording) {
      finish(true); $("message").textContent = "Grabación cancelada al ocultar la pestaña. Mantén la promo visible para exportar sin saltos.";
    } else pause();
  });
  if (location.protocol === "file:") { $("file-label").hidden = false; $("message").textContent = "Carga FreeScratch.mp3 o ejecuta node promo/serve.mjs para abrir la promo con todos sus recursos."; }
  assetsReady.then(() => draw(0)).catch(() => {});
  // Inspection interface for reproducible frame review and browser verification.
  window.promo = { draw: (t) => { if (!state.running) { state.time = clamp(t, 0, duration); draw(state.time); controls(); } },
    get analysis() { return state.analysis; }, get running() { return state.running; } };
  draw(0); controls();
})();
