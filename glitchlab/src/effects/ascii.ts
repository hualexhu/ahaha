import { applyMix, createImg, luma, type Img } from '../core/image';
import { parseHex, type RGB } from './color';
import { mixParam, num, str, type EffectDef, type GlyphAtlas, type Params } from './types';

export const CHARSETS: Record<string, string> = {
  classic: '.:-=+*#%@',
  blocks: ' ░▒▓█',
  binary: '01',
};

export function charsetOf(p: Params): string[] {
  const name = str(p, 'charset', 'classic');
  const s = name === 'custom' ? str(p, 'custom', '') : CHARSETS[name] ?? CHARSETS.classic;
  const chars = Array.from(s);
  return chars.length ? chars : Array.from(CHARSETS.classic);
}

/** Cell geometry for a nominal cell size: monospace glyphs are ~0.6 em wide. */
export function cellDims(size: number): { cellW: number; cellH: number } {
  const cellW = Math.max(2, Math.round(size));
  return { cellW, cellH: Math.max(3, Math.round(cellW / 0.6)) };
}

/**
 * DOM-free fallback glyphs: a centred box whose area grows with the
 * character's position in the set. Used in tests and if no canvas exists.
 */
export function syntheticGlyphs(chars: string[], cellW: number, cellH: number): GlyphAtlas {
  const masks = chars.map((c, i) => {
    const m = new Float32Array(cellW * cellH);
    if (c.trim() === '') return m;
    const f = Math.sqrt((i + 1) / chars.length);
    const bw = Math.max(1, Math.round(cellW * f)), bh = Math.max(1, Math.round(cellH * f * 0.8));
    const x0 = (cellW - bw) >> 1, y0 = (cellH - bh) >> 1;
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) m[y * cellW + x] = 1;
    return m;
  });
  return { cellW, cellH, masks };
}

const TINTS: Record<string, RGB> = {
  mono: [232, 232, 232],
  amber: [255, 176, 0],
  green: [51, 255, 102],
};

export interface AsciiResult { img: Img; text: string }

export function renderAscii(img: Img, p: Params, atlas: GlyphAtlas, chars: string[]): AsciiResult {
  const W = img.width, H = img.height;
  const { cellW, cellH, masks } = atlas;
  const n = masks.length;
  const cols = Math.floor(W / cellW);
  const rows = Math.floor(H / cellH);
  const mode = str(p, 'colorMode', 'green');
  const bg = parseHex(str(p, 'background', '#000000'));
  const tint = TINTS[mode];
  const out = createImg(W, H);
  const d = out.data;
  // background everywhere (including the margin that doesn't fit a whole cell)
  for (let i = 0; i < d.length; i += 4) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255; }
  // centre the grid
  const ox = Math.floor((W - cols * cellW) / 2);
  const oy = Math.floor((H - rows * cellH) / 2);
  const lines: string[] = [];
  const src = img.data;
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      const x0 = ox + c * cellW, y0 = oy + r * cellH;
      for (let y = y0; y < y0 + cellH; y += 2) {
        for (let x = x0; x < x0 + cellW; x += 2) {
          const i = (y * W + x) * 4;
          sr += src[i]; sg += src[i + 1]; sb += src[i + 2]; cnt++;
        }
      }
      sr /= cnt; sg /= cnt; sb /= cnt;
      const l = luma(sr, sg, sb) / 255;
      const idx = Math.min(n - 1, Math.floor(l * n));
      line += chars[idx] ?? ' ';
      let fr: number, fg: number, fb: number;
      if (tint) {
        const k = 0.55 + 0.45 * l;
        fr = tint[0] * k; fg = tint[1] * k; fb = tint[2] * k;
      } else {
        // original colour, lifted a little so dark cells stay readable
        fr = Math.min(255, sr * 1.2 + 20); fg = Math.min(255, sg * 1.2 + 20); fb = Math.min(255, sb * 1.2 + 20);
      }
      const m = masks[idx];
      for (let y = 0; y < cellH; y++) {
        let o = ((y0 + y) * W + x0) * 4;
        const mo = y * cellW;
        for (let x = 0; x < cellW; x++, o += 4) {
          const a = m[mo + x];
          if (a <= 0) continue;
          d[o] = bg[0] + (fr - bg[0]) * a;
          d[o + 1] = bg[1] + (fg - bg[1]) * a;
          d[o + 2] = bg[2] + (fb - bg[2]) * a;
        }
      }
    }
    lines.push(line);
  }
  return { img: out, text: lines.join('\n') };
}

export const asciiEffect: EffectDef = {
  type: 'ascii',
  label: 'ASCII',
  description: 'Render the image as characters on a grid (text also exportable).',
  params: [
    {
      kind: 'select', key: 'charset', label: 'Characters', default: 'classic',
      options: [
        { value: 'classic', label: '.:-=+*#%@' },
        { value: 'blocks', label: 'block shades ░▒▓█' },
        { value: 'binary', label: '01' },
        { value: 'custom', label: 'custom' },
      ],
    },
    { kind: 'text', key: 'custom', label: 'Custom set (dark → bright)', default: ' .oO@', maxLength: 64, visibleIf: (p) => p.charset === 'custom' },
    { kind: 'range', key: 'cell', label: 'Cell size', min: 4, max: 32, step: 1, default: 8, int: true, pixels: true, unit: 'px' },
    {
      kind: 'select', key: 'colorMode', label: 'Colour', default: 'green',
      options: [{ value: 'mono', label: 'mono' }, { value: 'amber', label: 'amber' }, { value: 'green', label: 'green' }, { value: 'original', label: 'original colour' }],
    },
    { kind: 'color', key: 'background', label: 'Background', default: '#000000' },
    mixParam,
  ],
  apply: (img, p, _rng, ctx) => {
    const chars = charsetOf(p);
    // never let a cell exceed the frame
    const size = Math.max(2, Math.min(num(p, 'cell', 8), img.width, img.height * 0.6));
    const { cellW, cellH } = cellDims(size);
    const atlas = ctx.glyphs ? ctx.glyphs(chars, cellW, cellH) : syntheticGlyphs(chars, cellW, cellH);
    const res = renderAscii(img, p, atlas, chars);
    ctx.side.asciiText = res.text;
    return applyMix(img, res.img, num(p, 'mix', 1));
  },
};
