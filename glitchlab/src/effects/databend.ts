import { cloneImg, luma, type Img } from '../core/image';
import { mulberry32, type Rng } from '../core/rng';
import { decodeJpeg } from '../codec/jpegDecoder';
import { encodeJpeg } from '../codec/jpegEncoder';
import { applyMix } from '../core/image';
import { mixParam, num, bool, type EffectDef, type Params } from './types';

/*
 * JPEG databending: encode a frame to JPEG, corrupt specific structures of
 * the file, decode it again. Every corruption works on the raw bytes and
 * returns a new array; none of them touch the SOF dimensions, so the result
 * always has the same size as the input.
 */

export interface Segment {
  marker: number;
  /** Offset of the 0xFF of the marker. */
  start: number;
  /** Offset of the first payload byte (after the 2 length bytes). */
  body: number;
  /** Offset one past the end of the segment. */
  end: number;
}

/** List marker segments up to and including SOS. */
export function listSegments(b: Uint8Array): Segment[] {
  const out: Segment[] = [];
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) { pos++; continue; }
    const marker = b[pos + 1];
    if (marker === 0xff || marker === 0x00) { pos++; continue; }
    if (marker === 0xd9) break;
    if (marker >= 0xd0 && marker <= 0xd7) { pos += 2; continue; }
    const len = (b[pos + 2] << 8) | b[pos + 3];
    const seg = { marker, start: pos, body: pos + 4, end: pos + 2 + len };
    if (seg.end > b.length) break;
    out.push(seg);
    if (marker === 0xda) break;
    pos = seg.end;
  }
  return out;
}

/** Iterate over quantisation tables: callback gets (tableId, byte offset of entry k=0, precision 0|1). */
function forEachDQT(b: Uint8Array, fn: (id: number, off: number, precision: number) => void): void {
  for (const s of listSegments(b)) {
    if (s.marker !== 0xdb) continue;
    let p = s.body;
    while (p < s.end) {
      const pq = b[p] >> 4;
      const id = b[p] & 15;
      const size = pq ? 128 : 64;
      if (p + 1 + size > s.end) break;
      fn(id, p + 1, pq);
      p += 1 + size;
    }
  }
}

const getQ = (b: Uint8Array, off: number, pq: number, k: number): number => (pq ? (b[off + 2 * k] << 8) | b[off + 2 * k + 1] : b[off + k]);
const setQ = (b: Uint8Array, off: number, pq: number, k: number, v: number): void => {
  const x = Math.max(1, Math.min(pq ? 65535 : 255, Math.round(v)));
  if (pq) { b[off + 2 * k] = x >> 8; b[off + 2 * k + 1] = x & 255; } else b[off + k] = x;
};

export interface DqtOpts { intensity: number; lowCut: number; highCut: number }

/**
 * DQT: boost the low-frequency quantisers (k = 1..lowCut, zigzag order) so
 * coarse structure is amplified into blocky colour blow-outs, and pull the
 * high-frequency quantisers (k = highCut..63) towards the minimum so fine
 * detail vanishes. DC (k=0) is left alone. Intensity 0 = unchanged.
 */
export function glitchDQT(src: Uint8Array, o: DqtOpts, rng: Rng): Uint8Array {
  const b = src.slice();
  const i = Math.max(0, Math.min(1, o.intensity));
  if (i === 0) return b;
  const low = Math.max(0, Math.min(63, Math.round(o.lowCut)));
  const high = Math.max(1, Math.min(64, Math.round(o.highCut)));
  forEachDQT(b, (_id, off, pq) => {
    for (let k = 1; k < 64; k++) {
      const q = getQ(b, off, pq, k);
      if (k <= low) setQ(b, off, pq, k, q * (1 + i * rng.range(3, 9)));
      else if (k >= high) setQ(b, off, pq, k, q * (1 - i));
    }
  });
  return b;
}

/**
 * DHT: permute AC symbols *within groups that share the same magnitude
 * category* (low nibble). Code lengths are kept, so the bitstream stays in
 * sync but run-lengths land on the wrong coefficients → structural smearing.
 * Above intensity 0.75 one code of each touched table may also be moved to a
 * longer length (still a valid prefix code), which desynchronises decoding.
 */
export function glitchDHT(src: Uint8Array, o: { intensity: number }, rng: Rng): Uint8Array {
  const b = src.slice();
  const i = Math.max(0, Math.min(1, o.intensity));
  if (i === 0) return b;
  for (const s of listSegments(b)) {
    if (s.marker !== 0xc4) continue;
    let p = s.body;
    while (p + 17 <= s.end) {
      const tc = b[p] >> 4;
      const bitsOff = p + 1;
      let total = 0;
      for (let k = 0; k < 16; k++) total += b[bitsOff + k];
      const valsOff = p + 17;
      if (valsOff + total > s.end) break;
      if (tc === 1 && total > 2) {
        for (let size = 1; size <= 10; size++) {
          if (!rng.chance(i)) continue;
          const idx: number[] = [];
          for (let k = 0; k < total; k++) if ((b[valsOff + k] & 15) === size) idx.push(k);
          if (idx.length < 2) continue;
          const vals = idx.map((k) => b[valsOff + k]);
          const rot = 1 + rng.int(Math.max(1, Math.round(i * (idx.length - 1))));
          idx.forEach((k, j) => { b[valsOff + k] = vals[(j + rot) % vals.length]; });
        }
        if (i > 0.75 && rng.chance((i - 0.75) * 4)) {
          // move one code from length L to L+1 (keeps Kraft sum <= 1)
          const candidates: number[] = [];
          for (let l = 1; l < 16; l++) if (b[bitsOff + l - 1] > 0) candidates.push(l);
          if (candidates.length) {
            const l = candidates[rng.int(candidates.length)];
            b[bitsOff + l - 1]--;
            b[bitsOff + l]++;
          }
        }
      }
      p = valsOff + total;
    }
  }
  return b;
}

/** Locate the entropy-coded scan: [start, end) between the SOS header and EOI. */
export function scanRange(b: Uint8Array): [number, number] | null {
  const segs = listSegments(b);
  const sos = segs.find((s) => s.marker === 0xda);
  if (!sos) return null;
  let end = b.length;
  for (let k = b.length - 2; k >= sos.end; k--) {
    if (b[k] === 0xff && b[k + 1] === 0xd9) { end = k; break; }
  }
  return [sos.end, end];
}

export interface ScanOpts { intensity: number; count: number; start: number; end: number }

/**
 * Scan: corrupt `count` bytes of the entropy-coded data inside the
 * [start%, end%] region. Bytes that belong to a marker or a stuffed 0xFF00
 * pair are skipped, and 0xFF is never written, so the file keeps its
 * structure. Low intensity flips a single bit; high intensity replaces
 * whole bytes and occasionally copies a short run from elsewhere.
 */
export function glitchScan(src: Uint8Array, o: ScanOpts, rng: Rng): Uint8Array {
  const b = src.slice();
  const i = Math.max(0, Math.min(1, o.intensity));
  const count = Math.max(0, Math.round(o.count));
  if (i === 0 || count === 0) return b;
  const r = scanRange(b);
  if (!r) return b;
  const [s0, s1] = r;
  const len = s1 - s0;
  if (len < 16) return b;
  const a = Math.max(0, Math.min(1, Math.min(o.start, o.end)));
  const z = Math.max(0, Math.min(1, Math.max(o.start, o.end)));
  const lo = s0 + Math.floor(a * len);
  const hi = Math.max(lo + 1, s0 + Math.floor(z * len));
  const safe = (k: number): boolean => k > s0 && k < s1 - 1 && b[k] !== 0xff && b[k - 1] !== 0xff;
  for (let n = 0; n < count; n++) {
    const k = lo + rng.int(hi - lo);
    if (!safe(k)) continue;
    const mode = rng.next();
    let v: number;
    if (mode < 1 - i) v = b[k] ^ (1 << rng.int(8)); // single bit flip
    else if (mode < 1 - i * 0.3) v = rng.int(255); // random byte
    else {
      // short transplant from a donor position (bytes still sanitised)
      const donor = s0 + 1 + rng.int(len - 2);
      const runLen = 2 + rng.int(Math.max(1, Math.round(4 + i * 12)));
      for (let t = 0; t < runLen && k + t < s1 - 1; t++) {
        const kk = k + t;
        const dv = b[donor + t < s1 - 1 ? donor + t : donor];
        if (!safe(kk)) break;
        b[kk] = dv === 0xff ? 0xfe : dv;
      }
      continue;
    }
    b[k] = v === 0xff ? 0xfe : v;
  }
  return b;
}

/**
 * Chroma: amplify the mid-frequency AC and DC quantisers of the chroma table
 * (id 1) so colour detail explodes without touching luminance sharpness.
 * With higher intensity, the Cb/Cr scan selectors may be swapped (hue swap),
 * and a chroma component may be re-pointed at the luma quant table.
 */
export function glitchChroma(src: Uint8Array, o: { intensity: number }, rng: Rng): Uint8Array {
  const b = src.slice();
  const i = Math.max(0, Math.min(1, o.intensity));
  if (i === 0) return b;
  const kHi = 3 + Math.round(i * 25);
  forEachDQT(b, (id, off, pq) => {
    if (id !== 1) return;
    setQ(b, off, pq, 0, getQ(b, off, pq, 0) * (1 + i * rng.range(0.5, 2)));
    for (let k = 3; k <= kHi && k < 64; k++) setQ(b, off, pq, k, getQ(b, off, pq, k) * (1 + i * rng.range(1, 4)));
  });
  const segs = listSegments(b);
  if (i > 0.4 && rng.chance((i - 0.4) * 1.6)) {
    const sos = segs.find((s) => s.marker === 0xda);
    if (sos && b[sos.body] === 3) {
      // component selectors at body+1, body+3, body+5: swap the 2nd and 3rd
      const x = sos.body + 3, y = sos.body + 5;
      const t = b[x]; b[x] = b[y]; b[y] = t;
    }
  }
  if (i > 0.75 && rng.chance((i - 0.75) * 3)) {
    const sof = segs.find((s) => s.marker === 0xc0 || s.marker === 0xc1);
    if (sof && b[sof.body + 5] === 3) {
      const comp = 1 + rng.int(2); // Cb or Cr
      b[sof.body + 6 + comp * 3 + 2] = 0;
    }
  }
  return b;
}

/**
 * Zigzag: cyclically rotate the 63 AC entries of each quantisation table
 * (and add a few random swaps), so quantisers land on the wrong frequencies:
 * posterisation, embossing and ringing.
 */
export function glitchZigzag(src: Uint8Array, o: { intensity: number }, rng: Rng): Uint8Array {
  const b = src.slice();
  const i = Math.max(0, Math.min(1, o.intensity));
  if (i === 0) return b;
  const rotation = Math.max(1, Math.round(i * 40));
  const swaps = Math.round(i * 12);
  forEachDQT(b, (_id, off, pq) => {
    const ac: number[] = [];
    for (let k = 1; k < 64; k++) ac.push(getQ(b, off, pq, k));
    for (let s = 0; s < swaps; s++) {
      const x = rng.int(63), y = rng.int(63);
      const t = ac[x]; ac[x] = ac[y]; ac[y] = t;
    }
    for (let k = 0; k < 63; k++) setQ(b, off, pq, k + 1, ac[(k + rotation) % 63]);
  });
  return b;
}

export interface DatabendParams {
  quality: number;
  zigzag: number; dqt: number; dht: number; scan: number; chroma: number;
  dqtLowCut: number; dqtHighCut: number;
  scanBytes: number; scanStart: number; scanEnd: number;
}

/** Apply the enabled corruptions, in the camera's order: zigzag, DQT, DHT, scan, chroma. */
export function corruptJpeg(bytes: Uint8Array, p: DatabendParams, rng: Rng, pixels: number): Uint8Array {
  let b = bytes;
  if (p.zigzag > 0) b = glitchZigzag(b, { intensity: p.zigzag }, rng);
  if (p.dqt > 0) b = glitchDQT(b, { intensity: p.dqt, lowCut: p.dqtLowCut, highCut: p.dqtHighCut }, rng);
  if (p.dht > 0) b = glitchDHT(b, { intensity: p.dht }, rng);
  if (p.scan > 0) {
    // byte count is expressed per megapixel so preview and export look alike
    const count = Math.max(1, Math.round((p.scanBytes * pixels) / 1e6));
    b = glitchScan(b, { intensity: p.scan, count, start: p.scanStart, end: p.scanEnd }, rng);
  }
  if (p.chroma > 0) b = glitchChroma(b, { intensity: p.chroma }, rng);
  return b;
}

function lumaStdDev(img: Img): number {
  const d = img.data;
  const step = Math.max(1, Math.floor(img.width * img.height / 20000)) * 4;
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < d.length; i += step) {
    const y = luma(d[i], d[i + 1], d[i + 2]);
    s += y; s2 += y * y; n++;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

export interface DatabendResult {
  img: Img;
  bytes: Uint8Array;
  attempts: number;
  fellBack: boolean;
}

export function readDatabendParams(p: Params): DatabendParams {
  const on = (k: string): number => (bool(p, k + 'On') ? num(p, k) : 0);
  return {
    quality: num(p, 'quality', 60),
    zigzag: on('zigzag'), dqt: on('dqt'), dht: on('dht'), scan: on('scan'), chroma: on('chroma'),
    dqtLowCut: num(p, 'dqtLowCut', 6), dqtHighCut: num(p, 'dqtHighCut', 40),
    scanBytes: num(p, 'scanBytes', 40), scanStart: num(p, 'scanStart', 0.05), scanEnd: num(p, 'scanEnd', 1),
  };
}

/**
 * Full databend with the safety net: if the corrupted file fails to decode
 * (or decodes to an essentially blank frame), retry at half the intensity,
 * up to 3 times, then fall back to the previous good frame (video) or the
 * clean JPEG round-trip. Never throws, never returns an empty frame.
 */
export function databend(
  img: Img, p: DatabendParams, rng: Rng, previousGood?: Img | null,
  decode: (b: Uint8Array) => ReturnType<typeof decodeJpeg> = decodeJpeg,
): DatabendResult {
  const clean = encodeJpeg(img, { quality: p.quality });
  const baseStd = lumaStdDev(img);
  const seedBase = rng.int(0x7fffffff);
  let scale = 1;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const q: DatabendParams = {
      ...p,
      zigzag: p.zigzag * scale, dqt: p.dqt * scale, dht: p.dht * scale,
      scan: p.scan * scale, chroma: p.chroma * scale, scanBytes: p.scanBytes * scale,
    };
    const bytes = corruptJpeg(clean, q, mulberry32(seedBase + attempt * 7919), img.width * img.height);
    const res = decode(bytes);
    if (res.ok) {
      const blank = baseStd > 4 && lumaStdDev(res.img) < 1;
      const mostlyMissing = res.stats.mcusWithData < res.stats.mcus * 0.25;
      if (!blank && !mostlyMissing) return { img: res.img, bytes, attempts: attempt + 1, fellBack: false };
    }
    scale *= 0.5;
  }
  if (previousGood && previousGood.width === img.width && previousGood.height === img.height) {
    return { img: cloneImg(previousGood), bytes: clean, attempts: 4, fellBack: true };
  }
  const plain = decode(clean);
  return { img: plain.ok ? plain.img : cloneImg(img), bytes: clean, attempts: 4, fellBack: true };
}

const onToggle = (key: string, label: string, def: boolean) =>
  ({ kind: 'toggle', key: key + 'On', label, default: def }) as const;

export const databendEffect: EffectDef = {
  type: 'databend',
  label: 'JPEG Databend',
  description: 'Encode to JPEG, corrupt the file’s tables and scan data, decode again.',
  params: [
    { kind: 'range', key: 'quality', label: 'JPEG quality', min: 10, max: 100, step: 1, default: 60, int: true },
    onToggle('dqt', 'DQT (quant tables)', true),
    { kind: 'range', key: 'dqt', label: 'DQT intensity', min: 0, max: 1, step: 0.01, default: 0.5, visibleIf: (p) => p.dqtOn === true },
    { kind: 'range', key: 'dqtLowCut', label: 'DQT low cut (k)', min: 0, max: 63, step: 1, default: 6, int: true, visibleIf: (p) => p.dqtOn === true },
    { kind: 'range', key: 'dqtHighCut', label: 'DQT high cut (k)', min: 1, max: 64, step: 1, default: 40, int: true, visibleIf: (p) => p.dqtOn === true },
    onToggle('dht', 'DHT (Huffman)', false),
    { kind: 'range', key: 'dht', label: 'DHT intensity', min: 0, max: 1, step: 0.01, default: 0.4, visibleIf: (p) => p.dhtOn === true },
    onToggle('scan', 'Scan data', true),
    { kind: 'range', key: 'scan', label: 'Scan intensity', min: 0, max: 1, step: 0.01, default: 0.5, visibleIf: (p) => p.scanOn === true },
    { kind: 'range', key: 'scanBytes', label: 'Bytes / MP', min: 1, max: 400, step: 1, default: 40, int: true, visibleIf: (p) => p.scanOn === true },
    { kind: 'range', key: 'scanStart', label: 'Region start', min: 0, max: 1, step: 0.01, default: 0.05, visibleIf: (p) => p.scanOn === true },
    { kind: 'range', key: 'scanEnd', label: 'Region end', min: 0, max: 1, step: 0.01, default: 1, visibleIf: (p) => p.scanOn === true },
    onToggle('chroma', 'Chroma', false),
    { kind: 'range', key: 'chroma', label: 'Chroma intensity', min: 0, max: 1, step: 0.01, default: 0.5, visibleIf: (p) => p.chromaOn === true },
    onToggle('zigzag', 'Zigzag', false),
    { kind: 'range', key: 'zigzag', label: 'Zigzag intensity', min: 0, max: 1, step: 0.01, default: 0.3, visibleIf: (p) => p.zigzagOn === true },
    mixParam,
  ],
  apply: (img, p, rng, ctx) => {
    const st = ctx.state as { lastGood?: Img };
    const res = databend(img, readDatabendParams(p), rng, st.lastGood ?? null);
    if (res.fellBack) ctx.side.notes.push('databend: corrupted JPEG failed to decode; used fallback frame');
    else if (res.attempts > 1) ctx.side.notes.push(`databend: decoded after ${res.attempts} attempts (intensity reduced)`);
    if (!res.fellBack) st.lastGood = res.img;
    ctx.side.jpegBytes = res.bytes;
    const mix = num(p, 'mix', 1);
    return mix < 1 ? applyMix(img, cloneImg(res.img), mix) : res.img;
  },
};
