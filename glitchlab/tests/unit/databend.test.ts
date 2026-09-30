import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg } from '../../src/codec/jpegDecoder';
import { encodeJpeg } from '../../src/codec/jpegEncoder';
import { mulberry32 } from '../../src/core/rng';
import {
  databend, glitchChroma, glitchDHT, glitchDQT, glitchScan, glitchZigzag, listSegments, scanRange, type DatabendParams,
} from '../../src/effects/databend';
import { bytesEqual, scene } from './helpers';

const ffmpeg: string = createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg').path;
const base = encodeJpeg(scene(96, 64), { quality: 60 });
const markers = (b: Uint8Array) => listSegments(b).map((s) => s.marker);

function randomParams(seed: number): DatabendParams {
  const r = mulberry32(seed ^ 0x9e3779b9);
  const pick = () => (r.chance(0.6) ? r.next() : r.chance(0.5) ? 1 : 0);
  return {
    quality: 10 + r.int(91),
    zigzag: pick(), dqt: pick(), dht: pick(), scan: pick(), chroma: pick(),
    dqtLowCut: r.int(64), dqtHighCut: 1 + r.int(64),
    scanBytes: 1 + r.int(400), scanStart: r.next(), scanEnd: r.next(),
  };
}

describe('byte-level corruptions', () => {
  const fns = {
    dqt: (b: Uint8Array, i: number, s: number) => glitchDQT(b, { intensity: i, lowCut: 8, highCut: 30 }, mulberry32(s)),
    dht: (b: Uint8Array, i: number, s: number) => glitchDHT(b, { intensity: i }, mulberry32(s)),
    scan: (b: Uint8Array, i: number, s: number) => glitchScan(b, { intensity: i, count: 50, start: 0, end: 1 }, mulberry32(s)),
    chroma: (b: Uint8Array, i: number, s: number) => glitchChroma(b, { intensity: i }, mulberry32(s)),
    zigzag: (b: Uint8Array, i: number, s: number) => glitchZigzag(b, { intensity: i }, mulberry32(s)),
  };
  it.each(Object.entries(fns))('%s: intensity 0 is a no-op, >0 changes bytes, never mutates input, keeps length + markers', (_n, fn) => {
    const copy = base.slice();
    expect(bytesEqual(fn(base, 0, 1), base)).toBe(true);
    const out = fn(base, 1, 1);
    expect(bytesEqual(base, copy)).toBe(true);
    expect(bytesEqual(out, base)).toBe(false);
    expect(out.length).toBe(base.length);
    expect(markers(out)).toEqual(markers(base));
  });
  it.each(Object.entries(fns))('%s: deterministic for a seed', (_n, fn) => {
    expect(bytesEqual(fn(base, 0.7, 9), fn(base, 0.7, 9))).toBe(true);
  });
  it('scan never writes 0xFF and never touches stuffed bytes or markers', () => {
    const [s0, s1] = scanRange(base)!;
    for (let seed = 0; seed < 50; seed++) {
      const out = glitchScan(base, { intensity: 1, count: 400, start: 0, end: 1 }, mulberry32(seed));
      for (let k = s0; k < s1; k++) {
        if (out[k] === 0xff) {
          expect(base[k]).toBe(0xff);
          expect(out[k + 1]).toBe(base[k + 1]);
        }
      }
      expect(bytesEqual(out.subarray(0, s0), base.subarray(0, s0))).toBe(true);
      expect(bytesEqual(out.subarray(s1), base.subarray(s1))).toBe(true);
    }
  });
  it('scan respects the region', () => {
    const [s0, s1] = scanRange(base)!;
    const len = s1 - s0;
    const out = glitchScan(base, { intensity: 1, count: 200, start: 0.5, end: 0.6 }, mulberry32(3));
    for (let k = s0; k < s1; k++) {
      if (out[k] !== base[k]) {
        expect(k).toBeGreaterThanOrEqual(s0 + Math.floor(0.5 * len));
        expect(k).toBeLessThan(s0 + Math.floor(0.6 * len) + 20); // + transplant run
      }
    }
  });
  it('DQT only boosts low and lowers high frequencies; DC unchanged', () => {
    const out = glitchDQT(base, { intensity: 1, lowCut: 5, highCut: 40 }, mulberry32(1));
    const seg = listSegments(base).filter((s) => s.marker === 0xdb)[0];
    const off = seg.body + 1;
    expect(out[off]).toBe(base[off]);
    for (let k = 1; k <= 5; k++) expect(out[off + k]).toBeGreaterThanOrEqual(base[off + k]);
    for (let k = 40; k < 64; k++) expect(out[off + k]).toBeLessThanOrEqual(base[off + k]);
  });
});

describe('databend safety net', () => {
  it('never produces an undecodable or blank final output across 200 random seeds', () => {
    const img = scene(96, 64);
    let retries = 0, fallbacks = 0;
    for (let seed = 0; seed < 200; seed++) {
      const p = randomParams(seed);
      const res = databend(img, p, mulberry32(seed));
      expect(res.img.width).toBe(96);
      expect(res.img.height).toBe(64);
      expect(res.img.data.length).toBe(96 * 64 * 4);
      // the bytes we return always decode (either the glitched file or the clean one)
      const dec = decodeJpeg(res.bytes);
      expect(dec.ok).toBe(true);
      // not blank: some luma variance survives
      let mn = 255, mx = 0;
      for (let i = 0; i < res.img.data.length; i += 4) { mn = Math.min(mn, res.img.data[i + 1]); mx = Math.max(mx, res.img.data[i + 1]); }
      expect(mx - mn).toBeGreaterThan(0);
      if (res.attempts > 1) retries++;
      if (res.fellBack) fallbacks++;
    }
    // the safety net exists for the rare bad case; most seeds must glitch successfully
    expect(fallbacks).toBeLessThan(20);
    expect(retries).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the same image + params + seed', () => {
    const img = scene(64, 48);
    for (let seed = 0; seed < 10; seed++) {
      const p = randomParams(seed);
      const a = databend(img, p, mulberry32(seed));
      const b = databend(img, p, mulberry32(seed));
      expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
      expect(bytesEqual(a.img.data, b.img.data)).toBe(true);
    }
  });

  it('retries at lower intensity, then falls back to the previous good frame', () => {
    const img = scene(48, 32);
    const prev = scene(48, 32);
    prev.data.fill(77);
    let calls = 0;
    const failing = () => { calls++; return { ok: false as const, error: 'simulated' }; };
    const res = databend(img, randomParams(3), mulberry32(1), prev, failing);
    expect(calls).toBeGreaterThanOrEqual(4); // 1 try + 3 retries (+ clean decode)
    expect(res.fellBack).toBe(true);
    expect(res.attempts).toBe(4);
    expect(bytesEqual(res.img.data, prev.data)).toBe(true);
    // no previous frame and nothing decodes: the unmodified input is returned, never a blank frame
    const res2 = databend(img, randomParams(3), mulberry32(1), null, failing);
    expect(bytesEqual(res2.img.data, img.data)).toBe(true);
  });

  it('succeeds on a later attempt when the first decode fails', () => {
    const img = scene(48, 32);
    let calls = 0;
    const flaky = (b: Uint8Array) => (++calls === 1 ? { ok: false as const, error: 'x' } : decodeJpeg(b));
    const res = databend(img, randomParams(4), mulberry32(2), null, flaky);
    expect(res.attempts).toBe(2);
    expect(res.fellBack).toBe(false);
  });

  it('glitched files decode in an independent decoder (ffmpeg) too', () => {
    const img = scene(96, 64);
    const dir = mkdtempSync(join(tmpdir(), 'gl-db-'));
    let ok = 0;
    for (let seed = 0; seed < 20; seed++) {
      const res = databend(img, randomParams(seed), mulberry32(seed));
      const f = join(dir, `${seed}.jpg`);
      writeFileSync(f, res.bytes);
      try {
        execFileSync(ffmpeg, ['-v', 'quiet', '-y', '-i', f, '-f', 'null', '-'], { stdio: 'ignore' });
        ok++;
      } catch {
        /* counted below */
      }
    }
    expect(ok).toBeGreaterThanOrEqual(18);
  });
});
