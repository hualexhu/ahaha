import { applyMix, cloneImg, luma, type Img } from '../core/image';
import { parseColorList, rgb565, toHex, type RGB } from './color';
import { quantizeLuma, type DitherMode } from './dither';
import { mixParam, num, str, type EffectDef, type Params } from './types';

/**
 * 4-tone viewfinder palettes, dark → bright. The colours reproduce the look of
 * the CyberShot Cam viewfinder presets (defined there as RGB565 values for a
 * small TFT; converted here to 8-bit RGB).
 */
export const VIEWFINDER_PALETTES: Record<string, RGB[]> = {
  green: [0x00c0, 0x0260, 0x0480, 0x07c0].map(rgb565),
  red: [0x2000, 0x5000, 0x9000, 0xf800].map(rgb565),
  pink: [0x2804, 0x6009, 0xa050, 0xf8dc].map(rgb565),
  white: [0x18c3, 0x4208, 0x8410, 0xffff].map(rgb565),
  cyan: [0x0106, 0x028c, 0x04d4, 0x07ff].map(rgb565),
};

/** Sample a multi-stop gradient at `n` evenly spaced positions. */
export function sampleGradient(stops: RGB[], n: number): RGB[] {
  if (stops.length === 0) return [];
  if (stops.length === 1 || n === 1) return Array.from({ length: n }, () => stops[0]);
  if (n === stops.length) return stops.slice();
  const out: RGB[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (stops.length - 1);
    const a = Math.floor(t);
    const b = Math.min(stops.length - 1, a + 1);
    const f = t - a;
    out.push([0, 1, 2].map((c) => stops[a][c] + (stops[b][c] - stops[a][c]) * f) as RGB);
  }
  return out;
}

export function paletteColours(p: Params): RGB[] {
  const preset = str(p, 'preset', 'green');
  let stops = preset === 'custom' ? parseColorList(str(p, 'colors')) : VIEWFINDER_PALETTES[preset] ?? VIEWFINDER_PALETTES.green;
  if (stops.length < 2) stops = VIEWFINDER_PALETTES.green;
  const tones = Math.max(2, Math.min(8, Math.round(num(p, 'tones', 4))));
  return sampleGradient(stops.slice(0, 8), tones);
}

export function applyPalette(img: Img, p: Params): Img {
  const out = cloneImg(img);
  const colours = paletteColours(p);
  const n = colours.length;
  const contrast = num(p, 'contrast', 0);
  const cf = contrast >= 0 ? 1 + contrast * 3 : 1 + contrast;
  const W = img.width, H = img.height;
  const d = out.data;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
    lum[j] = Math.max(0, Math.min(255, (luma(d[i], d[i + 1], d[i + 2]) - 128) * cf + 128));
  }
  const tones = quantizeLuma(lum, W, H, n, str(p, 'dither', 'none') as DitherMode);
  for (let i = 0, j = 0; j < tones.length; i += 4, j++) {
    const c = colours[tones[j]];
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
  return applyMix(img, out, num(p, 'mix', 1));
}

export const paletteEffect: EffectDef = {
  type: 'palette',
  label: 'Palette / Viewfinder',
  description: 'Map luminance to a few tones, like the camera’s TFT viewfinder.',
  params: [
    {
      kind: 'select', key: 'preset', label: 'Palette', default: 'green',
      options: [
        ...Object.keys(VIEWFINDER_PALETTES).map((k) => ({ value: k, label: k })),
        { value: 'custom', label: 'custom' },
      ],
    },
    {
      kind: 'colors', key: 'colors', label: 'Custom colours', min: 2, max: 8,
      default: ['#0d0221', '#541388', '#d90368', '#f1e9da'].join(','),
      visibleIf: (p) => p.preset === 'custom',
    },
    { kind: 'range', key: 'tones', label: 'Tones', min: 2, max: 8, step: 1, default: 4, int: true },
    {
      kind: 'select', key: 'dither', label: 'Dither', default: 'none',
      options: [{ value: 'none', label: 'none' }, { value: 'bayer', label: 'Bayer 4×4' }, { value: 'floyd', label: 'Floyd–Steinberg' }],
    },
    { kind: 'range', key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, default: 0 },
    mixParam,
  ],
  apply: (img, p) => applyPalette(img, p),
};

export const paletteHex = (name: string): string[] => (VIEWFINDER_PALETTES[name] ?? []).map(toHex);
