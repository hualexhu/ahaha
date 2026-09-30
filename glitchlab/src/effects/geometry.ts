import { createImg, resizeArea, type Img } from '../core/image';
import { bool, num, str, type EffectDef, type Params } from './types';

export const ASPECTS: Record<string, number | null> = {
  original: null,
  free: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

export interface CropRect { x: number; y: number; w: number; h: number }

/**
 * Resolve the crop rectangle (in pixels) for an image, from normalised crop
 * params. Ratio presets shrink the stored box around its centre to the ratio.
 */
export function resolveCrop(W: number, H: number, p: Params): CropRect {
  const aspect = str(p, 'aspect', 'original');
  if (aspect === 'original') return { x: 0, y: 0, w: W, h: H };
  let x = num(p, 'cropX', 0) * W;
  let y = num(p, 'cropY', 0) * H;
  let w = Math.max(1, num(p, 'cropW', 1) * W);
  let h = Math.max(1, num(p, 'cropH', 1) * H);
  const ratio = ASPECTS[aspect];
  if (ratio) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    x = cx - w / 2;
    y = cy - h / 2;
  }
  w = Math.min(W, Math.max(1, Math.round(w)));
  h = Math.min(H, Math.max(1, Math.round(h)));
  x = Math.min(W - w, Math.max(0, Math.round(x)));
  y = Math.min(H - h, Math.max(0, Math.round(y)));
  return { x, y, w, h };
}

/** Crop → rotate → flip → scale. */
export function applyGeometry(img: Img, p: Params): Img {
  const { x: cx, y: cy, w: cw, h: ch } = resolveCrop(img.width, img.height, p);
  const rot = ((Math.round(num(p, 'rotate', 0) / 90) % 4) + 4) % 4;
  const fh = bool(p, 'flipH');
  const fv = bool(p, 'flipV');
  const W = rot % 2 ? ch : cw;
  const H = rot % 2 ? cw : ch;
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  let out = createImg(W, H);
  const dst = new Uint32Array(out.data.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // position in the output before flips
      const ox = fh ? W - 1 - x : x;
      const oy = fv ? H - 1 - y : y;
      // inverse rotation into crop space
      let sx: number, sy: number;
      if (rot === 0) { sx = ox; sy = oy; }
      else if (rot === 1) { sx = oy; sy = ch - 1 - ox; } // 90° clockwise
      else if (rot === 2) { sx = cw - 1 - ox; sy = ch - 1 - oy; }
      else { sx = cw - 1 - oy; sy = ox; } // 270°
      dst[y * W + x] = src[(cy + sy) * img.width + cx + sx];
    }
  }
  const scale = parseFloat(str(p, 'scale', '1')) || 1;
  if (scale < 1) out = resizeArea(out, Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
  return out;
}

export const geometryEffect: EffectDef = {
  type: 'geometry',
  label: 'Geometry',
  description: 'Crop to an aspect ratio, rotate, flip and scale the output.',
  params: [
    {
      kind: 'select', key: 'aspect', label: 'Crop', default: 'original',
      options: Object.keys(ASPECTS).map((k) => ({ value: k, label: k })),
    },
    { kind: 'range', key: 'cropX', label: 'Crop X', min: 0, max: 1, step: 0.001, default: 0, visibleIf: (p) => p.aspect !== 'original' },
    { kind: 'range', key: 'cropY', label: 'Crop Y', min: 0, max: 1, step: 0.001, default: 0, visibleIf: (p) => p.aspect !== 'original' },
    { kind: 'range', key: 'cropW', label: 'Crop width', min: 0.02, max: 1, step: 0.001, default: 1, visibleIf: (p) => p.aspect !== 'original' },
    { kind: 'range', key: 'cropH', label: 'Crop height', min: 0.02, max: 1, step: 0.001, default: 1, visibleIf: (p) => p.aspect !== 'original' },
    {
      kind: 'select', key: 'rotate', label: 'Rotate', default: '0',
      options: [{ value: '-90', label: '−90°' }, { value: '0', label: '0°' }, { value: '90', label: '+90°' }, { value: '180', label: '180°' }],
    },
    { kind: 'toggle', key: 'flipH', label: 'Flip horizontal', default: false },
    { kind: 'toggle', key: 'flipV', label: 'Flip vertical', default: false },
    {
      kind: 'select', key: 'scale', label: 'Output scale', default: '1',
      options: [{ value: '1', label: '1/1' }, { value: '0.5', label: '1/2' }, { value: '0.25', label: '1/4' }],
    },
  ],
  apply: (img, p) => {
    const q = { ...p, rotate: parseFloat(String(p.rotate)) || 0 };
    return applyGeometry(img, q);
  },
};
