import type { Img } from '../core/image';
import {
  AC_CHROMA, AC_LUMA, DC_CHROMA, DC_LUMA, STD_CHROMA_Q, STD_LUMA_Q, ZIGZAG,
  buildCodes, scaleQuant, type HuffSpec,
} from './jpegTables';

/**
 * Baseline sequential JPEG encoder: 3 components, 4:2:0 (or 4:4:4) subsampling,
 * Annex-K Huffman tables. Written for GlitchLab so that the exact byte layout
 * is known and deterministic in every environment (browser, worker, Node).
 */

/** DCT basis: COS[u*8+x] = c(u)/2 * cos((2x+1)uπ/16). */
export const DCT_COS: Float64Array = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) t[u * 8 + x] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

class ByteWriter {
  buf: Uint8Array;
  pos = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }
  u16(v: number): void {
    this.ensure(2);
    this.buf[this.pos++] = (v >> 8) & 0xff;
    this.buf[this.pos++] = v & 0xff;
  }
  bytes(a: ArrayLike<number>): void {
    this.ensure(a.length);
    for (let i = 0; i < a.length; i++) this.buf[this.pos++] = a[i];
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function writeDHT(w: ByteWriter, cls: number, id: number, spec: HuffSpec): void {
  w.u16(0xffc4);
  w.u16(2 + 1 + 16 + spec.vals.length);
  w.byte((cls << 4) | id);
  w.bytes(spec.bits);
  w.bytes(spec.vals);
}

export interface EncodeOptions {
  quality: number;
  /** Chroma subsampling. Default: 4:2:0 below quality 90, 4:4:4 from 90 up. */
  subsample?: boolean;
}

export function encodeJpeg(img: Img, opts: EncodeOptions): Uint8Array {
  const { width: W, height: H, data } = img;
  const qLuma = scaleQuant(STD_LUMA_Q, opts.quality);
  const qChroma = scaleQuant(STD_CHROMA_Q, opts.quality);
  // Reciprocals in natural order, with the DCT normalisation already folded in.
  const rqL = new Float64Array(64);
  const rqC = new Float64Array(64);
  for (let i = 0; i < 64; i++) {
    rqL[i] = 1 / qLuma[i];
    rqC[i] = 1 / qChroma[i];
  }

  const w = new ByteWriter(Math.max(4096, (W * H) >> 1));
  // SOI + JFIF APP0
  w.u16(0xffd8);
  w.u16(0xffe0);
  w.u16(16);
  w.bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  // DQT: one segment per table, zigzag order, 8-bit precision
  for (const [id, q] of [[0, qLuma], [1, qChroma]] as const) {
    w.u16(0xffdb);
    w.u16(67);
    w.byte(id);
    for (let k = 0; k < 64; k++) w.byte(q[ZIGZAG[k]]);
  }
  // SOF0
  w.u16(0xffc0);
  w.u16(17);
  w.byte(8);
  w.u16(H);
  w.u16(W);
  w.byte(3);
  const sub = opts.subsample ?? opts.quality < 90;
  w.bytes([1, sub ? 0x22 : 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  // DHT
  writeDHT(w, 0, 0, DC_LUMA);
  writeDHT(w, 1, 0, AC_LUMA);
  writeDHT(w, 0, 1, DC_CHROMA);
  writeDHT(w, 1, 1, AC_CHROMA);
  // SOS
  w.u16(0xffda);
  w.u16(12);
  w.byte(3);
  w.bytes([1, 0x00, 2, 0x11, 3, 0x11]);
  w.bytes([0, 63, 0]);

  const dcL = buildCodes(DC_LUMA)!;
  const acL = buildCodes(AC_LUMA)!;
  const dcC = buildCodes(DC_CHROMA)!;
  const acC = buildCodes(AC_CHROMA)!;

  // ---- entropy coder state ----
  let bitBuf = 0;
  let bitCnt = 0;
  const putBits = (code: number, len: number): void => {
    bitBuf = (bitBuf << len) | (code & ((1 << len) - 1));
    bitCnt += len;
    while (bitCnt >= 8) {
      const b = (bitBuf >>> (bitCnt - 8)) & 0xff;
      w.ensure(2);
      w.buf[w.pos++] = b;
      if (b === 0xff) w.buf[w.pos++] = 0;
      bitCnt -= 8;
    }
    bitBuf &= (1 << bitCnt) - 1;
  };

  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  const coef = new Int32Array(64);

  const fdctQuant = (rq: Float64Array): void => {
    // rows
    for (let y = 0; y < 8; y++) {
      const o = y * 8;
      for (let u = 0; u < 8; u++) {
        const c = u * 8;
        tmp[o + u] =
          block[o] * DCT_COS[c] + block[o + 1] * DCT_COS[c + 1] + block[o + 2] * DCT_COS[c + 2] +
          block[o + 3] * DCT_COS[c + 3] + block[o + 4] * DCT_COS[c + 4] + block[o + 5] * DCT_COS[c + 5] +
          block[o + 6] * DCT_COS[c + 6] + block[o + 7] * DCT_COS[c + 7];
      }
    }
    // columns
    for (let x = 0; x < 8; x++) {
      for (let v = 0; v < 8; v++) {
        const c = v * 8;
        const s =
          tmp[x] * DCT_COS[c] + tmp[8 + x] * DCT_COS[c + 1] + tmp[16 + x] * DCT_COS[c + 2] +
          tmp[24 + x] * DCT_COS[c + 3] + tmp[32 + x] * DCT_COS[c + 4] + tmp[40 + x] * DCT_COS[c + 5] +
          tmp[48 + x] * DCT_COS[c + 6] + tmp[56 + x] * DCT_COS[c + 7];
        const n = v * 8 + x;
        coef[n] = Math.round(s * rq[n]);
      }
    }
  };

  const magnitude = (v: number): number => {
    let a = v < 0 ? -v : v;
    let n = 0;
    while (a) { n++; a >>= 1; }
    return n;
  };

  const encodeBlock = (prevDC: number, dc: { code: Int32Array; len: Int32Array }, ac: { code: Int32Array; len: Int32Array }): number => {
    const d = coef[0] - prevDC;
    const ds = magnitude(d);
    putBits(dc.code[ds], dc.len[ds]);
    if (ds) putBits(d < 0 ? d + (1 << ds) - 1 : d, ds);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coef[ZIGZAG[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) {
        putBits(ac.code[0xf0], ac.len[0xf0]);
        run -= 16;
      }
      const s = magnitude(v);
      const sym = (run << 4) | s;
      putBits(ac.code[sym], ac.len[sym]);
      putBits(v < 0 ? v + (1 << s) - 1 : v, s);
      run = 0;
    }
    if (run > 0) putBits(ac.code[0], ac.len[0]);
    return coef[0];
  };

  // Colour-converted MCU planes: Y 16x16 (or 8x8 without subsampling), Cb/Cr 8x8
  const M = sub ? 16 : 8;
  const Y = new Float64Array(M * M);
  const Cb = new Float64Array(64);
  const Cr = new Float64Array(64);
  const cshift = sub ? 1 : 0;
  const cscale = sub ? 0.25 : 1;
  let pY = 0, pCb = 0, pCr = 0;
  const mcuX = Math.ceil(W / M);
  const mcuY = Math.ceil(H / M);

  for (let my = 0; my < mcuY; my++) {
    for (let mx = 0; mx < mcuX; mx++) {
      Cb.fill(0);
      Cr.fill(0);
      for (let yy = 0; yy < M; yy++) {
        const sy = Math.min(H - 1, my * M + yy);
        const row = sy * W;
        for (let xx = 0; xx < M; xx++) {
          const sx = Math.min(W - 1, mx * M + xx);
          const i = (row + sx) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          Y[yy * M + xx] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          const ci = (yy >> cshift) * 8 + (xx >> cshift);
          Cb[ci] += -0.168736 * r - 0.331264 * g + 0.5 * b;
          Cr[ci] += 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      const nb = M / 8;
      for (let by = 0; by < nb; by++) {
        for (let bx = 0; bx < nb; bx++) {
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) block[y * 8 + x] = Y[(by * 8 + y) * M + bx * 8 + x];
          }
          fdctQuant(rqL);
          pY = encodeBlock(pY, dcL, acL);
        }
      }
      for (let i = 0; i < 64; i++) block[i] = Cb[i] * cscale;
      fdctQuant(rqC);
      pCb = encodeBlock(pCb, dcC, acC);
      for (let i = 0; i < 64; i++) block[i] = Cr[i] * cscale;
      fdctQuant(rqC);
      pCr = encodeBlock(pCr, dcC, acC);
    }
  }
  // pad final byte with 1-bits
  if (bitCnt > 0) putBits((1 << (8 - bitCnt)) - 1, 8 - bitCnt);
  w.u16(0xffd9);
  return w.result();
}
