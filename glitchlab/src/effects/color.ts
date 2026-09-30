/** Colour helpers shared by several effects. */

export type RGB = [number, number, number];

export function parseHex(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(v) || h.length < 6) return [0, 0, 0];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

export function parseColorList(s: string): RGB[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(x))
    .map(parseHex);
}

/** Convert an RGB565 value (as used by small TFT displays) to 8-bit RGB. */
export function rgb565(v: number): RGB {
  const r = (v >> 11) & 31;
  const g = (v >> 5) & 63;
  const b = v & 31;
  return [Math.round((r * 255) / 31), Math.round((g * 255) / 63), Math.round((b * 255) / 31)];
}

export function rgbToHsv(r: number, g: number, b: number): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

/** Nearest colour (squared RGB distance with a mild luma weighting). */
export function nearestIndex(palette: Float32Array, n: number, r: number, g: number, b: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function flatPalette(p: RGB[]): Float32Array {
  const out = new Float32Array(p.length * 3);
  p.forEach((c, i) => out.set(c, i * 3));
  return out;
}
