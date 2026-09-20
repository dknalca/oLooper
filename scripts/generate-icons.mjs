#!/usr/bin/env node
// Generate oLooper icon source SVG and all Tauri-required PNG sizes.
// Run: node scripts/generate-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ICONS_DIR = join(ROOT, "src-tauri", "icons");

// --- Waveform ring path generation ---
const CX = 512, CY = 512, R = 290;
const NUM_PEAKS = 80;

function generateWaveformPath() {
  const points = [];
  for (let i = 0; i <= NUM_PEAKS; i++) {
    const angle = (i / NUM_PEAKS) * Math.PI * 2 - Math.PI / 2;
    // Combine 3 sine waves for organic waveform shape
    const wave =
      0.5 * Math.sin(i * 0.8) +
      0.3 * Math.sin(i * 1.7 + 1.2) +
      0.2 * Math.sin(i * 3.1 + 0.5);
    const amplitude = 25 + Math.abs(wave) * 65; // 25–90px
    const innerR = R - amplitude;
    const outerR = R + amplitude;
    const xi = CX + innerR * Math.cos(angle);
    const yi = CY + innerR * Math.sin(angle);
    const xo = CX + outerR * Math.cos(angle);
    const yo = CY + outerR * Math.sin(angle);
    points.push({ xi, yi, xo, yo });
  }

  // Build SVG path: draw each peak as a line from inner to outer
  let d = "";
  for (const p of points) {
    d += `M${p.xi.toFixed(1)},${p.yi.toFixed(1)}L${p.xo.toFixed(1)},${p.yo.toFixed(1)} `;
  }
  return d;
}

// Loop gap: remove peaks between ~330° and ~360° (gap at 2 o'clock)
const GAP_START = 0.92; // fraction of full circle (~331°)
const GAP_END = 1.0;    // back to start

function generateWaveformPathWithGap() {
  const points = [];

  for (let i = 0; i <= NUM_PEAKS; i++) {
    const frac = i / NUM_PEAKS;
    // Skip peaks in the gap
    if (frac > GAP_START && frac < GAP_END) continue;

    const angle = frac * Math.PI * 2 - Math.PI / 2;
    const wave =
      0.5 * Math.sin(i * 0.8) +
      0.3 * Math.sin(i * 1.7 + 1.2) +
      0.2 * Math.sin(i * 3.1 + 0.5);
    const amplitude = 25 + Math.abs(wave) * 65;
    const innerR = R - amplitude;
    const outerR = R + amplitude;
    const xi = CX + innerR * Math.cos(angle);
    const yi = CY + innerR * Math.sin(angle);
    const xo = CX + outerR * Math.cos(angle);
    const yo = CY + outerR * Math.sin(angle);
    points.push({ xi, yi, xo, yo });
  }

  let d = "";
  for (const p of points) {
    d += `M${p.xi.toFixed(1)},${p.yi.toFixed(1)}L${p.xo.toFixed(1)},${p.yo.toFixed(1)} `;
  }
  return d;
}

const waveformPath = generateWaveformPathWithGap();

// Loop point marker position (end of gap)
const loopAngle = GAP_START * Math.PI * 2 - Math.PI / 2;
const loopX = CX + (R + 50) * Math.cos(loopAngle);
const loopY = CY + (R + 50) * Math.sin(loopAngle);

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="waveGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5bb3ff"/>
      <stop offset="100%" stop-color="#3a8de8"/>
    </linearGradient>
    <linearGradient id="oGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1a1a1a"/>
      <stop offset="100%" stop-color="#111111"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <!-- Background: rounded dark square -->
  <rect width="1024" height="1024" rx="180" ry="180" fill="#0a0a0a"/>
  <!-- Large "O" behind the waveform -->
  <text x="512" y="580" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="520" fill="url(#oGrad)" opacity="0.35">O</text>
  <!-- Subtle ring guide -->
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#1a1a1a" stroke-width="1"/>
  <!-- Waveform peaks -->
  <g filter="url(#glow)">
    <path d="${waveformPath}" stroke="url(#waveGrad)" stroke-width="3.5" stroke-linecap="round" fill="none" opacity="0.95"/>
  </g>
  <!-- Loop point marker: yellow dot -->
  <circle cx="${loopX.toFixed(1)}" cy="${loopY.toFixed(1)}" r="8" fill="#fbbf24" opacity="0.9"/>
</svg>
`;

const svgPath = join(ROOT, ".dev", "icon-source.svg");
mkdirSync(dirname(svgPath), { recursive: true });
mkdirSync(ICONS_DIR, { recursive: true });
writeFileSync(svgPath, svg);
console.log(`✓ SVG written to ${svgPath}`);

// --- Now generate PNGs using sharp ---
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("sharp not installed. Run: pnpm add -D sharp");
  process.exit(1);
}

const sizes = [
  { name: "icon.png", size: 1024 },
  { name: "128x128@2x.png", size: 256 },
  { name: "128x128.png", size: 128 },
  { name: "64x64.png", size: 64 },
  { name: "32x32.png", size: 32 },
];

for (const { name, size } of sizes) {
  const outPath = join(ICONS_DIR, name);
  await sharp(svgPath)
    .resize(size, size)
    .png()
    .toFile(outPath);
  console.log(`✓ ${name} (${size}x${size})`);
}

// Generate icns for macOS
const icnsPath = join(ICONS_DIR, "icon.icns");
try {
  // Use sips to convert 1024px PNG to icns via iconset
  const { execSync } = await import("node:child_process");
  const tmpDir = join(ROOT, ".dev", "icon.iconset");
  mkdirSync(tmpDir, { recursive: true });

  const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of icnsSizes) {
    const name1x = `icon_${s}x${s}.png`;
    const name2x = `icon_${s}x${s}@2x.png`;
    await sharp(svgPath).resize(s, s).png().toFile(join(tmpDir, name1x));
    if (s * 2 <= 1024) {
      await sharp(svgPath).resize(s * 2, s * 2).png().toFile(join(tmpDir, name2x));
    }
  }

  execSync(`iconutil -c icns "${tmpDir}" -o "${icnsPath}"`);
  console.log(`✓ icon.icns (macOS)`);
} catch (e) {
  console.error(`icns generation failed: ${e.message}`);
  process.exit(1);
}

console.log("\nDone! All icons generated in src-tauri/icons/");
