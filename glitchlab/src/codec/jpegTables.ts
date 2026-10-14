/**
 * Baseline JPEG constants (ITU T.81). The tables are the example tables from
 * Annex K of the standard; the zigzag order is generated rather than listed.
 */

/** ZIGZAG[k] = natural (row-major) index of the k-th coefficient in zigzag order. */
export const ZIGZAG: Int32Array = (() => {
  const out = new Int32Array(64);
  let x = 0;
  let y = 0;
  for (let k = 0; k < 64; k++) {
    out[k] = y * 8 + x;
    if ((x + y) % 2 === 0) {
      // moving up-right
      if (x === 7) y++;
      else if (y === 0) x++;
      else { x++; y--; }
    } else {
      // moving down-left
      if (y === 7) x++;
      else if (x === 0) y++;
      else { x--; y++; }
    }
  }
  return out;
})();

/** Annex K.1 luminance quantisation table, natural order. */
export const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

/** Annex K.2 chrominance quantisation table, natural order. */
export const STD_CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

/** IJG-style quality scaling (1..100) of a base table. Returns natural-order values 1..255. */
export function scaleQuant(base: number[], quality: number): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
  }
  return out;
}

export interface HuffSpec {
  /** Number of codes of each length 1..16. */
  bits: number[];
  /** Symbols in order of increasing code length. */
  vals: number[];
}

/** All AC symbols (run<<4 | size) with size 1..10, in row order of runs, appended after a prefix. */
function acTail(prefix: number[]): number[] {
  const seen = new Set(prefix);
  const out = [...prefix];
  for (let run = 0; run < 16; run++) {
    for (let size = 1; size <= 10; size++) {
      const s = (run << 4) | size;
      if (!seen.has(s)) { out.push(s); seen.add(s); }
    }
  }
  return out;
}

export const DC_LUMA: HuffSpec = {
  bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const DC_CHROMA: HuffSpec = {
  bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const AC_LUMA: HuffSpec = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: acTail([
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  ]),
};

export const AC_CHROMA: HuffSpec = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: acTail([
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  ]),
};

// Make sure 0x00 (EOB) is present in the luma AC list (it is in the prefix) — sanity checks live in tests.

/** Canonical Huffman code assignment (T.81 Annex C). Returns code and length per symbol, or null if the lengths are oversubscribed. */
export function buildCodes(spec: HuffSpec): { code: Int32Array; len: Int32Array } | null {
  const code = new Int32Array(256).fill(-1);
  const len = new Int32Array(256);
  let c = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < spec.bits[l - 1]; i++) {
      if (k >= spec.vals.length) return null;
      if (c >= 1 << l) return null;
      const sym = spec.vals[k++];
      code[sym] = c;
      len[sym] = l;
      c++;
    }
    c <<= 1;
  }
  return { code, len };
}
