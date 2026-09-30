import { createImg, type Img } from '../core/image';
import { ZIGZAG } from './jpegTables';
import { DCT_COS } from './jpegEncoder';

/**
 * Tolerant baseline JPEG decoder. It is deliberately forgiving about damaged
 * entropy-coded data (bad Huffman codes, premature end of data) the way
 * libjpeg is: it keeps going and produces smeared/garbled blocks instead of
 * throwing. Structural problems (missing tables, invalid Huffman tables,
 * unsupported frames) are reported as a failed decode.
 */

export interface DecodeStats {
  mcus: number;
  /** MCUs decoded before the entropy data ran out. */
  mcusWithData: number;
  badCodes: number;
}

export type DecodeResult =
  | { ok: true; img: Img; stats: DecodeStats }
  | { ok: false; error: string };

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  bw: number; // blocks per line (padded to MCU)
  bh: number;
  plane: Uint8ClampedArray; // bw*8 x bh*8 samples
  pred: number;
  td: number;
  ta: number;
}

interface HuffTable {
  /** 16-bit lookahead table: (length << 8) | symbol, 0 = invalid code. */
  lut: Int32Array;
}

function buildHuff(bits: Uint8Array, vals: Uint8Array): HuffTable | null {
  const lut = new Int32Array(65536);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    for (let i = 0; i < n; i++) {
      if (k >= vals.length) return null;
      if (code >= 1 << l) return null; // oversubscribed
      const start = code << (16 - l);
      const end = (code + 1) << (16 - l);
      const e = (l << 8) | vals[k];
      lut.fill(e, start, end);
      code++;
      k++;
    }
    code <<= 1;
  }
  if (k === 0) return null;
  return { lut };
}

export function decodeJpeg(bytes: Uint8Array): DecodeResult {
  try {
    return decodeInner(bytes);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function decodeInner(buf: Uint8Array): DecodeResult {
  const len = buf.length;
  if (len < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { ok: false, error: 'missing SOI' };
  const qt: (Int32Array | null)[] = [null, null, null, null];
  const dcT: (HuffTable | null)[] = [null, null, null, null];
  const acT: (HuffTable | null)[] = [null, null, null, null];
  let comps: Component[] = [];
  let W = 0, H = 0, hMax = 1, vMax = 1;
  let restartInterval = 0;
  let pos = 2;
  let stats: DecodeStats | null = null;

  while (pos + 4 <= len) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { pos += 2; continue; }
    const segLen = (buf[pos + 2] << 8) | buf[pos + 3];
    const segEnd = pos + 2 + segLen;
    if (segLen < 2 || segEnd > len) return { ok: false, error: 'truncated segment' };
    let p = pos + 4;
    switch (marker) {
      case 0xdb: { // DQT
        while (p < segEnd) {
          const pq = buf[p] >> 4;
          const tq = buf[p] & 15;
          p++;
          if (tq > 3) return { ok: false, error: 'bad DQT id' };
          const t = new Int32Array(64);
          for (let k = 0; k < 64; k++) {
            if (p >= segEnd + (pq ? 1 : 0)) return { ok: false, error: 'short DQT' };
            t[ZIGZAG[k]] = pq ? (buf[p] << 8) | buf[p + 1] : buf[p];
            p += pq ? 2 : 1;
          }
          qt[tq] = t;
        }
        break;
      }
      case 0xc0:
      case 0xc1: { // SOF0 / SOF1 (baseline / extended Huffman, 8-bit)
        if (buf[p] !== 8) return { ok: false, error: 'unsupported precision' };
        H = (buf[p + 1] << 8) | buf[p + 2];
        W = (buf[p + 3] << 8) | buf[p + 4];
        const nc = buf[p + 5];
        if (!W || !H || nc < 1 || nc > 4) return { ok: false, error: 'bad frame header' };
        if (W * H > 80_000_000) return { ok: false, error: 'image too large' };
        p += 6;
        comps = [];
        for (let i = 0; i < nc; i++) {
          const h = buf[p + 1] >> 4, v = buf[p + 1] & 15;
          if (h < 1 || h > 4 || v < 1 || v > 4) return { ok: false, error: 'bad sampling' };
          comps.push({ id: buf[p], h, v, tq: buf[p + 2] & 3, bw: 0, bh: 0, plane: new Uint8ClampedArray(0), pred: 0, td: 0, ta: 0 });
          p += 3;
        }
        hMax = Math.max(...comps.map((c) => c.h));
        vMax = Math.max(...comps.map((c) => c.v));
        const mcuX = Math.ceil(W / (8 * hMax));
        const mcuY = Math.ceil(H / (8 * vMax));
        for (const c of comps) {
          c.bw = mcuX * c.h;
          c.bh = mcuY * c.v;
          c.plane = new Uint8ClampedArray(c.bw * 8 * c.bh * 8).fill(128);
        }
        break;
      }
      case 0xc2: case 0xc3: case 0xc5: case 0xc6: case 0xc7: case 0xc9: case 0xca: case 0xcb:
      case 0xcd: case 0xce: case 0xcf:
        return { ok: false, error: 'unsupported JPEG process' };
      case 0xc4: { // DHT
        while (p + 17 <= segEnd) {
          const tc = buf[p] >> 4;
          const th = buf[p] & 15;
          if (tc > 1 || th > 3) return { ok: false, error: 'bad DHT id' };
          const bits = buf.subarray(p + 1, p + 17);
          let total = 0;
          for (let i = 0; i < 16; i++) total += bits[i];
          p += 17;
          if (total > 256 || p + total > segEnd) return { ok: false, error: 'bad DHT length' };
          const t = buildHuff(bits, buf.subarray(p, p + total));
          if (!t) return { ok: false, error: 'invalid Huffman table' };
          (tc === 0 ? dcT : acT)[th] = t;
          p += total;
        }
        break;
      }
      case 0xdd:
        restartInterval = (buf[p] << 8) | buf[p + 1];
        break;
      case 0xda: { // SOS
        if (!comps.length) return { ok: false, error: 'SOS before SOF' };
        const ns = buf[p];
        p++;
        const scomps: Component[] = [];
        for (let i = 0; i < ns; i++) {
          const c = comps.find((cc) => cc.id === buf[p]);
          if (!c) return { ok: false, error: 'unknown scan component' };
          c.td = buf[p + 1] >> 4;
          c.ta = buf[p + 1] & 15;
          if (c.td > 3 || c.ta > 3 || !dcT[c.td] || !acT[c.ta]) return { ok: false, error: 'missing Huffman table' };
          if (!qt[c.tq]) return { ok: false, error: 'missing quant table' };
          scomps.push(c);
          p += 2;
        }
        const next = decodeScan(buf, segEnd, scomps, qt as Int32Array[], dcT as HuffTable[], acT as HuffTable[], W, H, hMax, vMax, restartInterval);
        stats = next.stats;
        pos = next.end;
        continue;
      }
      default:
        break; // APPn, COM, etc.
    }
    pos = segEnd;
  }
  if (!stats) return { ok: false, error: 'no scan data' };
  if (stats.mcusWithData === 0) return { ok: false, error: 'empty scan' };
  return { ok: true, img: toRGB(comps, W, H, hMax, vMax), stats };
}

function decodeScan(
  buf: Uint8Array, start: number, scomps: Component[],
  qt: Int32Array[], dcT: HuffTable[], acT: HuffTable[],
  W: number, H: number, hMax: number, vMax: number, restartInterval: number,
): { end: number; stats: DecodeStats } {
  const len = buf.length;
  let pos = start;
  let bitBuf = 0; // up to 32 bits, left-aligned in the low `bitCnt` bits
  let bitCnt = 0;
  let hitMarker = false;
  let padBits = 0; // trailing zero bits that were invented after the data ran out
  let badCodes = 0;

  const fill = (): void => {
    while (bitCnt <= 24) {
      let b = 0;
      if (!hitMarker && pos < len) {
        b = buf[pos];
        if (b === 0xff) {
          const nb = pos + 1 < len ? buf[pos + 1] : 0xd9;
          if (nb === 0x00) pos += 2;
          else { hitMarker = true; b = 0; padBits += 8; }
        } else pos++;
      } else padBits += 8;
      bitBuf = ((bitBuf << 8) | b) >>> 0;
      bitCnt += 8;
    }
  };
  const peek16 = (): number => {
    if (bitCnt < 16) fill();
    return (bitBuf >>> (bitCnt - 16)) & 0xffff;
  };
  const skip = (n: number): void => {
    bitCnt -= n;
    if (padBits > bitCnt) padBits = bitCnt;
    bitBuf &= bitCnt >= 32 ? 0xffffffff : (2 ** bitCnt - 1) >>> 0;
  };
  const getBits = (n: number): number => {
    if (n === 0) return 0;
    if (bitCnt < n) fill();
    const v = (bitBuf >>> (bitCnt - n)) & ((1 << n) - 1);
    skip(n);
    return v;
  };
  const decodeSym = (t: HuffTable): number => {
    const e = t.lut[peek16()];
    if (e === 0) {
      badCodes++;
      skip(16);
      return 0;
    }
    skip(e >> 8);
    return e & 0xff;
  };
  const extend = (v: number, s: number): number => (v < 1 << (s - 1) ? v - (1 << s) + 1 : v);

  const coef = new Float64Array(64);
  const tmp = new Float64Array(64);

  const decodeBlock = (c: Component, bx: number, by: number): void => {
    coef.fill(0);
    const q = qt[c.tq];
    const s = decodeSym(dcT[c.td]);
    const diff = s ? extend(getBits(Math.min(s, 16)), Math.min(s, 16)) : 0;
    c.pred += diff;
    coef[0] = c.pred * q[0];
    let acOnly = false;
    const at = acT[c.ta];
    for (let k = 1; k < 64;) {
      const rs = decodeSym(at);
      const r = rs >> 4;
      const sz = rs & 15;
      if (sz === 0) {
        if (r === 15) { k += 16; continue; }
        break;
      }
      k += r;
      if (k > 63) break;
      const n = ZIGZAG[k];
      coef[n] = extend(getBits(sz), sz) * q[n];
      acOnly = true;
      k++;
    }
    // IDCT + store
    const plane = c.plane;
    const stride = c.bw * 8;
    let o = by * 8 * stride + bx * 8;
    if (!acOnly) {
      const v = coef[0] / 8 + 128;
      for (let y = 0; y < 8; y++, o += stride) for (let x = 0; x < 8; x++) plane[o + x] = v;
      return;
    }
    // columns: tmp[y][u] = sum_v C[v][y] * coef[v][u]
    for (let u = 0; u < 8; u++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) sum += DCT_COS[v * 8 + y] * coef[v * 8 + u];
        tmp[y * 8 + u] = sum;
      }
    }
    for (let y = 0; y < 8; y++, o += stride) {
      const r = y * 8;
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += DCT_COS[u * 8 + x] * tmp[r + u];
        plane[o + x] = sum + 128;
      }
    }
  };

  const single = scomps.length === 1;
  let mcus: number;
  let mcuX: number;
  if (single) {
    const c = scomps[0];
    mcuX = Math.ceil((Math.ceil((W * c.h) / hMax)) / 8);
    const mcuYc = Math.ceil((Math.ceil((H * c.v) / vMax)) / 8);
    mcus = mcuX * mcuYc;
  } else {
    mcuX = Math.ceil(W / (8 * hMax));
    mcus = mcuX * Math.ceil(H / (8 * vMax));
  }
  let mcusWithData = 0;
  for (const c of scomps) c.pred = 0;

  for (let m = 0; m < mcus; m++) {
    if (restartInterval && m > 0 && m % restartInterval === 0) {
      // resync on RSTn: drop buffered bits, skip to the marker
      bitBuf = 0; bitCnt = 0; padBits = 0;
      if (hitMarker && pos + 1 < len && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7) {
        pos += 2;
        hitMarker = false;
      } else {
        // search forward for the next RST marker
        while (pos + 1 < len && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) {
          if (buf[pos] === 0xff && buf[pos + 1] !== 0 && buf[pos + 1] !== 0xff) break;
          pos++;
        }
        if (pos + 1 < len && buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7) { pos += 2; hitMarker = false; }
      }
      for (const c of scomps) c.pred = 0;
    }
    if (!hitMarker || bitCnt > padBits) mcusWithData++;
    const mx = m % mcuX;
    const my = (m / mcuX) | 0;
    if (single) {
      const c = scomps[0];
      if (mx < c.bw && my < c.bh) decodeBlock(c, mx, my);
      else decodeBlock(c, Math.min(mx, c.bw - 1), Math.min(my, c.bh - 1));
    } else {
      for (const c of scomps) {
        for (let v = 0; v < c.v; v++) {
          for (let h = 0; h < c.h; h++) decodeBlock(c, mx * c.h + h, my * c.v + v);
        }
      }
    }
  }
  // find the end of the entropy data (next non-RST marker)
  let end = pos;
  while (end + 1 < len && !(buf[end] === 0xff && buf[end + 1] !== 0 && !(buf[end + 1] >= 0xd0 && buf[end + 1] <= 0xd7))) end++;
  return { end, stats: { mcus, mcusWithData, badCodes } };
}

function toRGB(comps: Component[], W: number, H: number, hMax: number, vMax: number): Img {
  const out = createImg(W, H);
  const d = out.data;
  const n = comps.length;
  const sample = (c: Component, x: number, y: number): number => {
    const sx = c.h === hMax ? x : ((x * c.h) / hMax) | 0;
    const sy = c.v === vMax ? y : ((y * c.v) / vMax) | 0;
    return c.plane[sy * c.bw * 8 + sx];
  };
  if (n >= 3) {
    const [cy, cb, cr] = comps;
    const fullRes = cy.h === hMax && cy.v === vMax;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const Y = fullRes ? cy.plane[y * cy.bw * 8 + x] : sample(cy, x, y);
        const B = sample(cb, x, y) - 128;
        const R = sample(cr, x, y) - 128;
        const i = (y * W + x) * 4;
        d[i] = Y + 1.402 * R;
        d[i + 1] = Y - 0.344136 * B - 0.714136 * R;
        d[i + 2] = Y + 1.772 * B;
        d[i + 3] = 255;
      }
    }
  } else {
    const c = comps[0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = sample(c, x, y);
        const i = (y * W + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
  }
  return out;
}
