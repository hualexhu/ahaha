import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeJpeg } from '../../src/codec/jpegDecoder';
import { encodeJpeg } from '../../src/codec/jpegEncoder';
import { AC_CHROMA, AC_LUMA, DC_CHROMA, DC_LUMA, ZIGZAG, buildCodes } from '../../src/codec/jpegTables';
import { noise, psnr, scene } from './helpers';

const ffmpeg: string = createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg').path;

describe('JPEG tables', () => {
  it('zigzag is a permutation that starts 0,1,8,16', () => {
    expect(new Set(ZIGZAG).size).toBe(64);
    expect(Array.from(ZIGZAG.slice(0, 6))).toEqual([0, 1, 8, 16, 9, 2]);
    expect(ZIGZAG[63]).toBe(63);
  });
  it.each([['DC luma', DC_LUMA, 12], ['DC chroma', DC_CHROMA, 12], ['AC luma', AC_LUMA, 162], ['AC chroma', AC_CHROMA, 162]])('%s is a complete valid prefix code', (_n, spec, count) => {
    expect(spec.bits.reduce((a, b) => a + b, 0)).toBe(count);
    expect(spec.vals.length).toBe(count);
    expect(new Set(spec.vals).size).toBe(count);
    expect(buildCodes(spec)).not.toBeNull();
  });
});

describe('JPEG codec', () => {
  it('round-trips with quality-dependent fidelity', () => {
    const img = scene(123, 77);
    let last = 0;
    for (const q of [20, 60, 95]) {
      const r = decodeJpeg(encodeJpeg(img, { quality: q }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.img.width).toBe(123);
      expect(r.img.height).toBe(77);
      const p = psnr(img, r.img);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
    // colour bars have hard chroma edges, which 4:2:0 subsampling softens
    expect(last).toBeGreaterThan(25);
  });
  it('is near-lossless on luma at high quality', () => {
    const img = scene(123, 77);
    for (let i = 0; i < img.data.length; i += 4) {
      const y = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = y;
    }
    const r = decodeJpeg(encodeJpeg(img, { quality: 95 }));
    expect(r.ok && psnr(img, r.img)).toBeGreaterThan(45);
  });
  it('is byte-deterministic', () => {
    const img = noise(40, 30);
    expect(encodeJpeg(img, { quality: 50 })).toEqual(encodeJpeg(img, { quality: 50 }));
  });
  it('handles tiny and odd sizes', () => {
    for (const [w, h] of [[1, 1], [7, 3], [17, 33]]) {
      const r = decodeJpeg(encodeJpeg(noise(w, h), { quality: 75 }));
      expect(r.ok && r.img.width === w && r.img.height === h).toBe(true);
    }
  });
  it('produces files a standard decoder (ffmpeg/libavcodec) reads identically-ish', () => {
    const img = scene(64, 48);
    const bytes = encodeJpeg(img, { quality: 90 });
    const dir = mkdtempSync(join(tmpdir(), 'gl-'));
    writeFileSync(join(dir, 'a.jpg'), bytes);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', join(dir, 'a.jpg'), '-f', 'rawvideo', '-pix_fmt', 'rgba', join(dir, 'a.rgba')]);
    const raw = readFileSync(join(dir, 'a.rgba'));
    const ours = decodeJpeg(bytes);
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    const theirs = { width: 64, height: 48, data: new Uint8ClampedArray(raw) };
    expect(psnr(ours.img, theirs)).toBeGreaterThan(30);
  });
  it('reports structural damage instead of throwing', () => {
    expect(decodeJpeg(new Uint8Array([1, 2, 3])).ok).toBe(false);
    const b = encodeJpeg(scene(32, 32), { quality: 50 });
    expect(decodeJpeg(b.slice(0, 200)).ok).toBe(false); // cut before the scan
    const cut = decodeJpeg(b.slice(0, Math.floor(b.length * 0.8)));
    expect(cut.ok).toBe(true); // truncated scan: tolerant, partial data
  });
});
