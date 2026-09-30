#!/usr/bin/env node
/**
 * Generates synthetic test fixtures into ./fixtures (git-ignored).
 * Nothing is downloaded: images are computed here, videos come from
 * ffmpeg's built-in `testsrc` generator (ffmpeg binary from the
 * @ffmpeg-installer/ffmpeg dev dependency).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures');
mkdirSync(out, { recursive: true });
const force = process.argv.includes('--force');

// ------------------------------------------------------------ tiny PNG writer
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// deterministic noise
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function image(name, w, h, fn) {
  const file = join(out, name);
  if (existsSync(file) && !force) return file;
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y, w, h);
    const i = (y * w + x) * 3;
    rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b;
  }
  writeFileSync(file, png(w, h, rgb));
  console.log('wrote', name);
  return file;
}

// A "scene": sky gradient, sun, hills, bars — gives every effect something to chew on.
const scene = (x, y, w, h) => {
  const u = x / w, v = y / h;
  let r = 20 + 200 * v, g = 40 + 120 * (1 - v), b = 180 - 120 * v;
  const dx = u - 0.7, dy = v - 0.3;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.12) { r = 255; g = 220 - d * 600; b = 80; }
  const hill = 0.62 + 0.08 * Math.sin(u * 9) + 0.04 * Math.sin(u * 23 + 1);
  if (v > hill) { r = 30 + 40 * Math.sin(u * 40); g = 110 + 60 * (v - hill); b = 40; }
  if (v > 0.85) {
    const bar = Math.floor(u * 8);
    const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
    [r, g, b] = bars[bar];
  }
  return [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))));
};

const gradient = (x, y, w, h) => [Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), Math.round(((x + y) / (w + h - 2)) * 255)];
const bars = (x, _y, w) => {
  const c = [[192, 192, 192], [192, 192, 0], [0, 192, 192], [0, 192, 0], [192, 0, 192], [192, 0, 0], [0, 0, 192]];
  return c[Math.min(6, Math.floor((x / w) * 7))];
};
const rnd = mulberry32(42);
const noise = () => [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.round);

const scenePng = image('scene.png', 960, 640, scene);
image('gradient.png', 640, 480, gradient);
image('bars.png', 640, 360, bars);
image('noise.png', 320, 240, noise);

function ff(args, target) {
  const file = join(out, target);
  if (existsSync(file) && !force) return;
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  console.log('wrote', target);
}

ff(['-i', scenePng, '-q:v', '3'], 'scene.jpg');
ff(['-i', join(out, 'gradient.png'), '-c:v', 'libwebp', '-quality', '85'], 'gradient.webp');
// 2 s, 320x240, 15 fps test pattern with a moving element (testsrc has a sweeping bar + counter)
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15'], 'testsrc.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-c:v', 'libvpx', '-b:v', '500k'], 'testsrc.webm');
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 'testsrc.mov');
console.log('fixtures ready in', out);
