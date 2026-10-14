import { createImg, type Img } from '../../src/core/image';
import { mulberry32 } from '../../src/core/rng';

/** Synthetic test scene: gradient sky, sun, hills and colour bars. */
export function scene(w = 96, h = 64): Img {
  const img = createImg(w, h);
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    let r = 20 + 200 * v, g = 40 + 120 * (1 - v), b = 180 - 120 * v;
    const d = Math.hypot(u - 0.7, v - 0.3);
    if (d < 0.12) { r = 255; g = 220 - d * 600; b = 80; }
    if (v > 0.62 + 0.08 * Math.sin(u * 9)) { r = 30 + 40 * Math.sin(u * 40); g = 130; b = 40; }
    if (v > 0.85) [r, g, b] = bars[Math.floor(u * 8)];
    const i = (y * w + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  return img;
}

export function noise(w = 48, h = 32, seed = 7): Img {
  const img = createImg(w, h);
  const r = mulberry32(seed);
  for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : r.int(256);
  return img;
}

export function solid(w: number, h: number, c: [number, number, number]): Img {
  const img = createImg(w, h);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; }
  return img;
}

export function maxAbsDiff(a: Img, b: Img): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let m = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
}

export function meanAbsDiff(a: Img, b: Img): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let s = 0, n = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) { s += Math.abs(a.data[i] - b.data[i]); n++; }
  return s / n;
}

export function psnr(a: Img, b: Img): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.data.length; i++) if (i % 4 !== 3) { se += (a.data[i] - b.data[i]) ** 2; n++; }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / n));
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
