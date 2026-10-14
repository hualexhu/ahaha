import { applyMix, cloneImg, type Img } from '../core/image';
import { bool, mixParam, num, type EffectDef, type Params } from './types';

/**
 * Colour grading: exposure, contrast, saturation, hue, then optional
 * grayscale / sepia / noir / invert looks. Implemented with per-channel LUTs
 * plus one 3x3 matrix so it stays fast on 12 MP frames.
 */
export function applyColour(img: Img, p: Params): Img {
  const out = cloneImg(img);
  const ev = num(p, 'exposure');
  const contrast = num(p, 'contrast');
  const sat = 1 + num(p, 'saturation');
  const hue = (num(p, 'hue') * Math.PI) / 180;
  const gray = bool(p, 'grayscale');
  const sepia = bool(p, 'sepia');
  const noir = bool(p, 'noir');
  const invert = bool(p, 'invert');

  // Tone LUT: exposure in (approximately) linear light, then contrast around mid-grey.
  const lut = new Uint8ClampedArray(256);
  const gain = Math.pow(2, ev);
  const cf = contrast >= 0 ? 1 + contrast * 3 : 1 + contrast;
  for (let v = 0; v < 256; v++) {
    let x = Math.pow(v / 255, 2.2) * gain;
    x = Math.pow(Math.min(1, x), 1 / 2.2) * 255;
    x = (x - 128) * cf + 128;
    lut[v] = x;
  }

  // Saturation + hue as one matrix: RGB -> YIQ, scale+rotate the chroma plane (I,Q), -> RGB.
  const lr = 0.299, lg = 0.587, lb = 0.114;
  const toYiq = [lr, lg, lb, 0.596, -0.274, -0.322, 0.211, -0.523, 0.312];
  const toRgb = [1, 0.956, 0.621, 1, -0.272, -0.647, 1, -1.106, 1.703];
  const c = Math.cos(hue) * sat, s = Math.sin(hue) * sat;
  const rot = [1, 0, 0, 0, c, -s, 0, s, c];
  const mul = (a: number[], b: number[]): number[] => {
    const o = new Array<number>(9).fill(0);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) o[r * 3 + k] += a[r * 3 + j] * b[j * 3 + k];
    return o;
  };
  const m = mul(toRgb, mul(rot, toYiq));
  const identityMatrix = sat === 1 && hue === 0;

  // Noir curve: strong S-curve with crushed blacks.
  const noirLut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.max(0, Math.min(1, (v / 255 - 0.08) / 0.84));
    const sc = x * x * (3 - 2 * x);
    noirLut[v] = Math.pow(sc, 1.15) * 255;
  }

  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    if (!identityMatrix) {
      const nr = m[0] * r + m[1] * g + m[2] * b;
      const ng = m[3] * r + m[4] * g + m[5] * b;
      const nb = m[6] * r + m[7] * g + m[8] * b;
      r = nr; g = ng; b = nb;
    }
    if (gray || sepia || noir) {
      let y = lr * r + lg * g + lb * b;
      if (noir) y = noirLut[y < 0 ? 0 : y > 255 ? 255 : y | 0];
      if (sepia) {
        // warm duotone: dark brown -> cream
        const t = y / 255;
        r = 40 + t * (255 - 40) * 0.98 + t * (1 - t) * 60;
        g = 22 + t * (236 - 22);
        b = 8 + t * (196 - 8);
      } else {
        r = g = b = y;
      }
    }
    if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return applyMix(img, out, num(p, 'mix', 1));
}

export const colourEffect: EffectDef = {
  type: 'colour',
  label: 'Colour',
  description: 'Exposure, contrast, saturation, hue and classic looks.',
  params: [
    { kind: 'range', key: 'exposure', label: 'Exposure', min: -3, max: 3, step: 0.05, default: 0, unit: 'EV' },
    { kind: 'range', key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, default: 0 },
    { kind: 'range', key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, default: 0 },
    { kind: 'range', key: 'hue', label: 'Hue shift', min: -180, max: 180, step: 1, default: 0, unit: '°' },
    { kind: 'toggle', key: 'grayscale', label: 'Grayscale', default: false },
    { kind: 'toggle', key: 'sepia', label: 'Sepia', default: false },
    { kind: 'toggle', key: 'noir', label: 'Noir', default: false },
    { kind: 'toggle', key: 'invert', label: 'Invert', default: false },
    mixParam,
  ],
  apply: (img, p) => applyColour(img, p),
};
