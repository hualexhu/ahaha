import type { Img } from '../core/image';
import { nearestIndex } from './color';

export type DitherMode = 'none' | 'bayer' | 'floyd';

/** 4x4 Bayer threshold matrix, values normalised to (-0.5, 0.5). */
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

/**
 * Map every pixel of `img` onto `palette` (flat RGB triples) in place.
 * `spread` is the ordered-dither amplitude in 0..255 units.
 * A cache keyed by the 15-bit colour speeds up nearest-colour search.
 */
export function quantizeToPalette(img: Img, palette: Float32Array, mode: DitherMode, spread = 48): void {
  const n = palette.length / 3;
  const d = img.data;
  const W = img.width;
  const H = img.height;
  const cache = new Int16Array(32768).fill(-1);
  const lookup = (r: number, g: number, b: number): number => {
    const ri = r < 0 ? 0 : r > 255 ? 255 : r;
    const gi = g < 0 ? 0 : g > 255 ? 255 : g;
    const bi = b < 0 ? 0 : b > 255 ? 255 : b;
    const key = ((ri >> 3) << 10) | ((gi >> 3) << 5) | (bi >> 3);
    let idx = cache[key];
    if (idx < 0) {
      idx = nearestIndex(palette, n, (ri & ~7) + 4, (gi & ~7) + 4, (bi & ~7) + 4);
      cache[key] = idx;
    }
    return idx;
  };

  if (mode === 'floyd') {
    // Serpentine Floyd–Steinberg with float error buffers for two rows.
    let cur = new Float32Array((W + 2) * 3);
    let nxt = new Float32Array((W + 2) * 3);
    for (let y = 0; y < H; y++) {
      const ltr = y % 2 === 0;
      for (let s = 0; s < W; s++) {
        const x = ltr ? s : W - 1 - s;
        const i = (y * W + x) * 4;
        const e = (x + 1) * 3;
        const r = d[i] + cur[e];
        const g = d[i + 1] + cur[e + 1];
        const b = d[i + 2] + cur[e + 2];
        const k = nearestIndex(palette, n, r, g, b);
        const pr = palette[k * 3], pg = palette[k * 3 + 1], pb = palette[k * 3 + 2];
        d[i] = pr; d[i + 1] = pg; d[i + 2] = pb;
        const er = r - pr, eg = g - pg, eb = b - pb;
        const fw = ltr ? 3 : -3; // forward neighbour offset in the error row
        cur[e + fw] += er * 7 / 16; cur[e + fw + 1] += eg * 7 / 16; cur[e + fw + 2] += eb * 7 / 16;
        nxt[e - fw] += er * 3 / 16; nxt[e - fw + 1] += eg * 3 / 16; nxt[e - fw + 2] += eb * 3 / 16;
        nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
        nxt[e + fw] += er / 16; nxt[e + fw + 1] += eg / 16; nxt[e + fw + 2] += eb / 16;
      }
      const t = cur; cur = nxt; nxt = t; nxt.fill(0);
    }
    return;
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = mode === 'bayer' ? BAYER4[(y & 3) * 4 + (x & 3)] * spread : 0;
      const k = lookup(d[i] + t, d[i + 1] + t, d[i + 2] + t);
      d[i] = palette[k * 3];
      d[i + 1] = palette[k * 3 + 1];
      d[i + 2] = palette[k * 3 + 2];
    }
  }
}

/** Luminance-only quantisation to `levels` steps with optional dithering. Returns tone indices 0..levels-1. */
export function quantizeLuma(lum: Float32Array, W: number, H: number, levels: number, mode: DitherMode): Uint8Array {
  const out = new Uint8Array(W * H);
  const step = 255 / (levels - 1);
  if (mode === 'floyd') {
    const buf = new Float32Array(lum);
    for (let y = 0; y < H; y++) {
      const ltr = y % 2 === 0;
      for (let s = 0; s < W; s++) {
        const x = ltr ? s : W - 1 - s;
        const i = y * W + x;
        const v = buf[i];
        const q = Math.max(0, Math.min(levels - 1, Math.round(v / step)));
        out[i] = q;
        const err = v - q * step;
        const f = ltr ? 1 : -1;
        if (x + f >= 0 && x + f < W) buf[i + f] += (err * 7) / 16;
        if (y + 1 < H) {
          if (x - f >= 0 && x - f < W) buf[i + W - f] += (err * 3) / 16;
          buf[i + W] += (err * 5) / 16;
          if (x + f >= 0 && x + f < W) buf[i + W + f] += err / 16;
        }
      }
    }
    return out;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = mode === 'bayer' ? BAYER4[(y & 3) * 4 + (x & 3)] * step : 0;
      out[i] = Math.max(0, Math.min(levels - 1, Math.round((lum[i] + t) / step)));
    }
  }
  return out;
}
