/**
 * Minimal RGBA image type. Structurally compatible with the DOM `ImageData`
 * so effects can run in Node (tests), a Web Worker or the main thread.
 */
export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImg(width: number, height: number): Img {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImg(img: Img): Img {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Rec.601 luma, 0..255. */
export const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/** Blend `out` towards `orig` in place: mix=1 keeps `out`, mix=0 restores `orig`. */
export function applyMix(orig: Img, out: Img, mix: number): Img {
  if (mix >= 1 || orig.width !== out.width || orig.height !== out.height) return out;
  const a = orig.data;
  const b = out.data;
  const m = clamp(mix, 0, 1);
  for (let i = 0; i < b.length; i++) b[i] = a[i] + (b[i] - a[i]) * m;
  return out;
}

/** Nearest-neighbour resample (used to keep video frame sizes constant). */
export function resizeNearest(img: Img, w: number, h: number): Img {
  if (img.width === w && img.height === h) return img;
  const out = createImg(w, h);
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  const dst = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      dst[y * w + x] = src[sy * img.width + sx];
    }
  }
  return out;
}

/** Box-filter downscale by an arbitrary factor (area average). Good quality for previews. */
export function resizeArea(img: Img, w: number, h: number): Img {
  if (img.width === w && img.height === h) return img;
  if (w > img.width || h > img.height) return resizeNearest(img, w, h);
  const out = createImg(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  const s = img.data;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += s[i]; g += s[i + 1]; b += s[i + 2]; a += s[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n; d[o + 3] = a / n;
    }
  }
  return out;
}

/** Fit (w,h) inside a long-edge limit, preserving aspect ratio. */
export function fitLongEdge(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
