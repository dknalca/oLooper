#!/usr/bin/env node
// Build a multi-size Windows ICO with classic 32-bit DIB frames. Using DIB
// frames keeps the icon readable by Explorer, shortcuts, and older Win32 APIs.

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src-tauri", "icons", "icon.png");
const destination = join(root, "src-tauri", "icons", "icon.ico");
const sharp = (await import("sharp")).default;

async function dibFrame(size) {
  const rgba = await sharp(source)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer();

  const xor = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const sourceY = size - 1 - y;
    const maskRow = y * maskStride;
    for (let x = 0; x < size; x++) {
      const sourceOffset = (sourceY * size + x) * 4;
      const destinationOffset = (y * size + x) * 4;
      const alpha = rgba[sourceOffset + 3];
      xor[destinationOffset] = rgba[sourceOffset + 2];
      xor[destinationOffset + 1] = rgba[sourceOffset + 1];
      xor[destinationOffset + 2] = rgba[sourceOffset];
      xor[destinationOffset + 3] = alpha;
      if (alpha < 128) andMask[maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // BITMAPINFOHEADER size
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR bitmap + AND mask
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // BGRA
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xor.length + andMask.length, 20);
  return Buffer.concat([header, xor, andMask]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map(dibFrame));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // icon resource
header.writeUInt16LE(frames.length, 4);

let offset = header.length + frames.length * 16;
const entries = frames.map((frame, index) => {
  const size = sizes[index];
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(frame.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += frame.length;
  return entry;
});

writeFileSync(destination, Buffer.concat([header, ...entries, ...frames]));
console.log(`Generated Windows icon with ${sizes.join(", ")} px DIB frames: ${destination}`);
