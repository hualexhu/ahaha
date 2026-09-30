import { applyMix, createImg, resizeArea, type Img } from '../core/image';
import { flatPalette, parseHex, type RGB } from './color';
import { quantizeToPalette, type DitherMode } from './dither';
import { mixParam, num, str, type EffectDef, type Params } from './types';

/** 3-3-2 bit RGB: 256 colours. */
const P256: RGB[] = (() => {
  const out: RGB[] = [];
  for (let r = 0; r < 8; r++) for (let g = 0; g < 8; g++) for (let b = 0; b < 4; b++) {
    out.push([Math.round((r * 255) / 7), Math.round((g * 255) / 7), Math.round((b * 255) / 3)]);
  }
  return out;
})();

export const FIXED_PALETTES: Record<string, RGB[]> = {
  p256: P256,
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'].map(parseHex),
  // CGA mode 4, palette 1, high intensity
  cga: ['#000000', '#55ffff', '#ff55ff', '#ffffff'].map(parseHex),
};

/**
 * Median cut: recursively split the box with the widest channel range at the
 * median until there are `n` boxes; each box's mean is a palette entry.
 */
export function medianCut(img: Img, n: number): RGB[] {
  const total = img.width * img.height;
  const step = Math.max(1, Math.floor(total / 65536));
  const count = Math.ceil(total / step);
  const px = new Uint8Array(count * 3);
  for (let j = 0, k = 0; j < total && k < count; j += step, k++) {
    px[k * 3] = img.data[j * 4];
    px[k * 3 + 1] = img.data[j * 4 + 1];
    px[k * 3 + 2] = img.data[j * 4 + 2];
  }
  interface Box { idx: Uint32Array; ch: number; range: number }
  const describe = (idx: Uint32Array): Box => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (const i of idx) for (let c = 0; c < 3; c++) {
      const v = px[i * 3 + c];
      if (v < mn[c]) mn[c] = v;
      if (v > mx[c]) mx[c] = v;
    }
    const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    return { idx, ch, range: r[ch] };
  };
  const all = new Uint32Array(count);
  for (let i = 0; i < count; i++) all[i] = i;
  const boxes: Box[] = [describe(all)];
  while (boxes.length < n) {
    let bi = -1, best = 0;
    boxes.forEach((b, i) => {
      const score = b.range * Math.sqrt(b.idx.length);
      if (b.idx.length > 1 && b.range > 0 && score > best) { best = score; bi = i; }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = Array.from(b.idx).sort((x, y) => px[x * 3 + b.ch] - px[y * 3 + b.ch] || x - y);
    const mid = sorted.length >> 1;
    boxes.splice(bi, 1, describe(Uint32Array.from(sorted.slice(0, mid))), describe(Uint32Array.from(sorted.slice(mid))));
  }
  return boxes.map((b) => {
    const s = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) s[c] += px[i * 3 + c];
    return s.map((v) => Math.round(v / b.idx.length)) as RGB;
  });
}

export function applyEightBit(img: Img, p: Params): Img {
  const block = Math.max(1, Math.round(num(p, 'block', 4)));
  const W = img.width, H = img.height;
  const sw = Math.max(1, Math.ceil(W / block));
  const sh = Math.max(1, Math.ceil(H / block));
  // pixelate: average each block (area resample to the block grid)
  const small = block > 1 ? resizeArea(img, sw, sh) : { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  const pal = str(p, 'palette', 'median');
  const colours = pal === 'median' ? medianCut(small, Math.max(2, Math.min(256, Math.round(num(p, 'colors', 16))))) : FIXED_PALETTES[pal] ?? P256;
  quantizeToPalette(small, flatPalette(colours), str(p, 'dither', 'none') as DitherMode, 255 / Math.max(2, Math.cbrt(colours.length)));
  let out: Img = small;
  if (block > 1) {
    out = createImg(W, H);
    const s = new Uint32Array(small.data.buffer);
    const d = new Uint32Array(out.data.buffer);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(sh - 1, Math.floor(y / block));
      for (let x = 0; x < W; x++) d[y * W + x] = s[sy * sw + Math.min(sw - 1, Math.floor(x / block))];
    }
  }
  return applyMix(img, out, num(p, 'mix', 1));
}

export const eightBitEffect: EffectDef = {
  type: 'eightbit',
  label: '8-bit',
  description: 'Pixelate into blocks and reduce to a small palette.',
  params: [
    { kind: 'range', key: 'block', label: 'Block size', min: 1, max: 32, step: 1, default: 4, int: true, pixels: true, unit: 'px' },
    {
      kind: 'select', key: 'palette', label: 'Palette', default: 'median',
      options: [
        { value: 'median', label: 'median cut (adaptive)' },
        { value: 'p256', label: '256-colour (RGB332)' },
        { value: 'gameboy', label: 'Game Boy green-4' },
        { value: 'cga', label: 'CGA (cyan/magenta)' },
      ],
    },
    { kind: 'range', key: 'colors', label: 'Colours', min: 2, max: 256, step: 1, default: 16, int: true, visibleIf: (p) => p.palette === 'median' },
    {
      kind: 'select', key: 'dither', label: 'Dither', default: 'none',
      options: [{ value: 'none', label: 'none' }, { value: 'bayer', label: 'Bayer 4×4' }, { value: 'floyd', label: 'Floyd–Steinberg' }],
    },
    mixParam,
  ],
  apply: (img, p) => applyEightBit(img, p),
};
