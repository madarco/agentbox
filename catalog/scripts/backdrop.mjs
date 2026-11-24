#!/usr/bin/env node
/*
 * Puts a light backdrop behind a tray menu or alert capture.
 *
 *   node scripts/backdrop.mjs <png>...
 *
 * Menus and alerts are drawn in a translucent material that the window server
 * blends with whatever is behind the window. `screencapture -l` takes the
 * window alone, so the material comes out blended over black: a flat
 * rgb(179,179,179), which reads as dark gray. The material is white at about
 * 70% opacity, so a pixel the capture shows as `v` over black would be
 * `v + see-through × backdrop` over a real desktop. The see-through amount is
 * estimated per pixel: 30% on bare material, less where dark or light content
 * covers it, none on coloured content (accent buttons, status dots).
 *
 * Run it once on a fresh capture: shoot-tray.mjs does. Running it twice
 * lightens the picture again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const MATERIAL = 179; // the bare material over black
const SEE_THROUGH = 0.3; // 1 - its opacity
const BACKDROP = 217; // a light desktop: bare material lands on rgb(244,244,244)

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/* 8-bit RGBA, non-interlaced: what screencapture writes. Other chunks (the
   colour profile among them) are kept as they are. */
function readPng(file) {
  const buf = readFileSync(file);
  const chunks = [];
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IDAT") idat.push(data);
    else chunks.push({ type, data });
    p += 12 + len;
  }
  const ihdr = chunks[0].data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) throw new Error(`${file}: expected 8-bit RGBA, non-interlaced`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (src[x] + pred) & 0xff;
    }
  }
  return { w, h, px, chunks };
}

function writePng(file, { w, h, px, chunks }) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  for (const c of chunks) {
    if (c.type === "IEND") parts.push(chunk("IDAT", deflateSync(raw, { level: 9 })));
    parts.push(chunk(c.type, c.data));
  }
  writeFileSync(file, Buffer.concat(parts));
}

export function addBackdrop(file) {
  const img = readPng(file);
  const { px } = img;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = (r + g + b) / 3;
    // How much of the pixel is bare material: dark content (text) over it
    // scales down to black, light content (icons, fills) up to white.
    const bare = v <= MATERIAL ? v / MATERIAL : (255 - v) / (255 - MATERIAL);
    // Coloured content is opaque; let antialiased edges fade in.
    const neutral = Math.max(0, 1 - (max - min) / 40);
    const add = bare * neutral * SEE_THROUGH * BACKDROP;
    px[i] = Math.min(255, Math.round(r + add));
    px[i + 1] = Math.min(255, Math.round(g + add));
    px[i + 2] = Math.min(255, Math.round(b + add));
  }
  writePng(file, img);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node scripts/backdrop.mjs <png>...");
    process.exit(1);
  }
  for (const f of files) addBackdrop(f);
}
