import { applyMix, cloneImg, type Img } from '../core/image';
import { rgbToHsv } from './color';
import { bool, mixParam, num, str, type EffectDef, type Params } from './types';

/**
 * Pixel sort: along each row (or column) find runs of pixels whose sort key
 * lies inside [low, high] and sort each run by that key.
 */
export function applyPixelSort(img: Img, p: Params): Img {
  const out = cloneImg(img);
  const W = img.width, H = img.height;
  const vertical = str(p, 'direction', 'h') === 'v';
  const keyName = str(p, 'key', 'luma');
  const low = num(p, 'low', 0.25);
  const high = num(p, 'high', 0.8);
  const reverse = bool(p, 'reverse');
  const minSpan = Math.max(2, Math.round(num(p, 'minSpan', 2)));
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, W * H);
  const dst = new Uint32Array(out.data.buffer);
  const d = img.data;

  // per-pixel key quantised to 0..1023
  const keys = new Uint16Array(W * H);
  for (let j = 0, i = 0; j < keys.length; j++, i += 4) {
    let k: number;
    if (keyName === 'hue') k = rgbToHsv(d[i], d[i + 1], d[i + 2])[0] / 360;
    else if (keyName === 'saturation') k = rgbToHsv(d[i], d[i + 1], d[i + 2])[1];
    else k = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    keys[j] = Math.min(1023, Math.round(k * 1023));
  }
  const lo = Math.round(low * 1023);
  const hi = Math.round(high * 1023);
  const lines = vertical ? W : H;
  const len = vertical ? H : W;
  const stride = vertical ? W : 1;
  const lineStep = vertical ? 1 : W;
  const packed = new Uint32Array(len);

  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let s = 0;
    while (s < len) {
      const k = keys[base + s * stride];
      if (k < lo || k > hi) { s++; continue; }
      let e = s + 1;
      while (e < len) {
        const kk = keys[base + e * stride];
        if (kk < lo || kk > hi) break;
        e++;
      }
      const n = e - s;
      if (n >= minSpan) {
        // pack key (high bits) with the position inside the run (low 16 bits) and sort numerically
        const view = packed.subarray(0, n);
        for (let t = 0; t < n; t++) view[t] = (keys[base + (s + t) * stride] << 16) | t;
        view.sort();
        for (let t = 0; t < n; t++) {
          const from = view[reverse ? n - 1 - t : t] & 0xffff;
          dst[base + (s + t) * stride] = src[base + (s + from) * stride];
        }
      }
      s = e;
    }
  }
  return applyMix(img, out, num(p, 'mix', 1));
}

export const pixelSortEffect: EffectDef = {
  type: 'pixelsort',
  label: 'Pixel Sort',
  description: 'Sort spans of pixels whose key lies between the thresholds.',
  params: [
    { kind: 'select', key: 'direction', label: 'Direction', default: 'h', options: [{ value: 'h', label: 'horizontal' }, { value: 'v', label: 'vertical' }] },
    {
      kind: 'select', key: 'key', label: 'Sort key', default: 'luma',
      options: [{ value: 'luma', label: 'luma' }, { value: 'hue', label: 'hue' }, { value: 'saturation', label: 'saturation' }],
    },
    { kind: 'range', key: 'low', label: 'Threshold low', min: 0, max: 1, step: 0.01, default: 0.25 },
    { kind: 'range', key: 'high', label: 'Threshold high', min: 0, max: 1, step: 0.01, default: 0.8 },
    { kind: 'toggle', key: 'reverse', label: 'Reverse', default: false },
    mixParam,
  ],
  apply: (img, p) => applyPixelSort(img, p),
};
