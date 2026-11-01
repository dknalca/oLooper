// Deterministic master export: no realtime capture and no dropped animation frames.
// Requires a running promo/serve.mjs, Playwright (with Chromium) and ffmpeg-static.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { access } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const tools = process.env.OLOOPER_RENDER_TOOLS;
const require = createRequire(tools ? resolve(tools, "package.json") : import.meta.url);
const output = resolve(process.argv[2] || resolve(root, "dist/oLooper-FreeScratch.mp4"));
let browser, encoder;
try {
  await access(dirname(output));
  const { chromium } = require("playwright");
  const ffmpeg = require("ffmpeg-static");
  browser = await chromium.launch({ headless: true,
    ...(process.env.OLOOPER_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OLOOPER_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  let renderError = null;
  page.on("pageerror", (error) => { renderError = error; });
  await page.goto("http://localhost:4173/promo/");
  await page.check("#mute");
  await page.click("#preview");
  await page.waitForFunction(() => window.promo.analysis !== null, { timeout: 30_000 });
  await page.click("#preview");
  const duration = await page.evaluate(() => window.promo.analysis.cuts.at(-1));
  const frames = Math.ceil(duration * 30);
  console.log(`Master: ${duration.toFixed(3)} s · ${frames} frames · 1920 × 1080 / 30 fps`);
  encoder = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-framerate", "30", "-vcodec", "mjpeg", "-i", "pipe:0",
    "-i", resolve(root, "promo/FreeScratch.mp3"), "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-af", `volume=0.88,afade=t=in:d=0.06,afade=t=out:st=${duration - 0.15}:d=0.15`,
    "-t", String(duration), "-movflags", "+faststart", output], { stdio: ["pipe", "inherit", "inherit"] });
  let encoderFailure = null;
  encoder.on("error", (error) => { encoderFailure = error; });
  encoder.stdin.on("error", (error) => { encoderFailure = error; });
  const exited = new Promise((resolve) => encoder.once("exit", (code) => resolve(code)));
  for (let frame = 0; frame < frames; frame++) {
    if (renderError) throw renderError;
    if (encoderFailure) throw encoderFailure;
    const jpeg = await page.evaluate((time) => {
      window.promo.draw(time);
      return document.getElementById("promo-canvas").toDataURL("image/jpeg", 0.95).split(",")[1];
    }, frame / 30);
    if (!encoder.stdin.write(Buffer.from(jpeg, "base64"))) await once(encoder.stdin, "drain");
    if (frame % 300 === 0) console.log(`${(frame / frames * 100).toFixed(0)}% · ${frame}/${frames}`);
  }
  encoder.stdin.end();
  const exitCode = await exited;
  if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);
  console.log(`Video listo: ${output}`);
} catch (error) {
  console.error(error.message);
  console.error("Consulta promo/guion.md: exportación máster con Playwright y FFmpeg.");
  encoder?.kill(); process.exitCode = 1;
} finally { await browser?.close(); }
