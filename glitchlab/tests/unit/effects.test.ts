import { describe, expect, it } from 'vitest';
import { cloneImg, type Img } from '../../src/core/image';
import { rngFor } from '../../src/core/rng';
import { EFFECTS } from '../../src/effects';
import { applyColour } from '../../src/effects/colour';
import { applyGeometry, resolveCrop } from '../../src/effects/geometry';
import { applyPalette, VIEWFINDER_PALETTES } from '../../src/effects/palette';
import { applyPixelSort } from '../../src/effects/pixelsort';
import { applyEightBit, medianCut } from '../../src/effects/eightbit';
import { defaultsOf, newContext, type EffectType, type Params } from '../../src/effects/types';
import { bytesEqual, maxAbsDiff, meanAbsDiff, noise, psnr, scene, solid } from './helpers';

const TYPES = Object.keys(EFFECTS) as EffectType[];

function run(type: EffectType, img: Img, params: Params, seed = 1, frame = 0, video = false, state: Record<string, unknown> = {}): Img {
  const def = EFFECTS[type];
  const ctx = newContext({ isVideo: video, frameIndex: frame, state });
  return def.apply(cloneImg(img), { ...defaultsOf(def.params), ...params }, rngFor(seed, type, frame), ctx);
}

/** Parameters that switch every optional part of an effect on. */
const EVERYTHING_ON: Partial<Record<EffectType, Params>> = {
  databend: { dqtOn: true, dhtOn: true, scanOn: true, chromaOn: true, zigzagOn: true },
  geometry: { aspect: '4:5', rotate: '90', flipH: true, flipV: true, scale: '0.5' },
  colour: { grayscale: true, sepia: true, noir: true, invert: true, exposure: 1, hue: 90 },
};

describe.each(TYPES)('%s effect', (type) => {
  const def = EFFECTS[type];
  const on = EVERYTHING_ON[type] ?? {};

  it('is deterministic: same seed → same bytes', () => {
    const img = scene(64, 48);
    const a = run(type, img, on, 42, 3, true);
    const b = run(type, img, on, 42, 3, true);
    expect(a.width).toBe(b.width);
    expect(bytesEqual(a.data, b.data)).toBe(true);
  });

  it('does not mutate its input', () => {
    const img = scene(40, 30);
    const copy = cloneImg(img);
    def.apply(img, { ...defaultsOf(def.params), ...on }, rngFor(1), newContext({ isVideo: true }));
    expect(bytesEqual(img.data, copy.data)).toBe(true);
  });

  it('accepts every parameter at its min and max (and every option)', () => {
    const img = noise(37, 29);
    const cases: Params[] = [];
    for (const s of def.params) {
      if (s.kind === 'range') cases.push({ [s.key]: s.min }, { [s.key]: s.max });
      if (s.kind === 'select') for (const o of s.options) cases.push({ [s.key]: o.value });
      if (s.kind === 'toggle') cases.push({ [s.key]: true }, { [s.key]: false });
      if (s.kind === 'text') cases.push({ [s.key]: '' }, { [s.key]: '█▓ab' });
      if (s.kind === 'colors') cases.push({ [s.key]: '#000,#fff' }, { [s.key]: 'nonsense' });
    }
    // all ranges at min together, then all at max together
    const allMin: Params = { ...on }, allMax: Params = { ...on };
    for (const s of def.params) if (s.kind === 'range') { allMin[s.key] = s.min; allMax[s.key] = s.max; }
    cases.push(allMin, allMax);
    for (const c of cases) {
      for (const video of [false, true]) {
        const out = run(type, img, { ...on, ...c }, 5, 1, video);
        expect(out.width).toBeGreaterThan(0);
        expect(out.height).toBeGreaterThan(0);
        expect(out.data.length).toBe(out.width * out.height * 4);
      }
    }
  });

  it('handles 1×1 and very thin images', () => {
    for (const [w, h] of [[1, 1], [1, 9], [9, 1]]) {
      const out = run(type, noise(w, h), on, 3, 0, true);
      expect(out.data.length).toBe(out.width * out.height * 4);
    }
  });
});

describe('identity: neutral parameters leave the image (almost) unchanged', () => {
  const img = scene(64, 48);
  it('colour defaults', () => {
    expect(maxAbsDiff(run('colour', img, {}), img)).toBeLessThanOrEqual(1);
  });
  it('geometry defaults', () => {
    expect(maxAbsDiff(run('geometry', img, {}), img)).toBe(0);
  });
  it('palette at mix 0', () => {
    expect(maxAbsDiff(run('palette', img, { mix: 0 }), img)).toBe(0);
  });
  it('pixel sort with an empty threshold window', () => {
    expect(maxAbsDiff(run('pixelsort', img, { low: 1, high: 0 }), img)).toBe(0);
    expect(maxAbsDiff(run('pixelsort', img, { mix: 0 }), img)).toBe(0);
  });
  it('8-bit with block 1 and a 256-colour adaptive palette', () => {
    expect(meanAbsDiff(run('eightbit', img, { block: 1, palette: 'median', colors: 256 }), img)).toBeLessThan(4);
  });
  it('ASCII at mix 0', () => {
    expect(maxAbsDiff(run('ascii', img, { mix: 0 }), img)).toBe(0);
  });
  it('databend with every corruption off at quality 100', () => {
    const out = run('databend', img, { quality: 100, dqtOn: false, dhtOn: false, scanOn: false, chromaOn: false, zigzagOn: false });
    expect(psnr(out, img)).toBeGreaterThan(38);
  });
  it('databend with intensities at 0', () => {
    const out = run('databend', img, { quality: 100, dqtOn: true, dqt: 0, dhtOn: true, dht: 0, scanOn: true, scan: 0, chromaOn: true, chroma: 0, zigzagOn: true, zigzag: 0 });
    expect(psnr(out, img)).toBeGreaterThan(38);
  });
  it('datamosh on stills, and with a keyframe every frame', () => {
    expect(maxAbsDiff(run('datamosh', img, {}, 1, 5, false), img)).toBe(0);
    const st = {};
    for (let f = 0; f < 4; f++) expect(maxAbsDiff(run('datamosh', noise(32, 32, f), { hold: 1 }, 1, f, true, st), noise(32, 32, f))).toBe(0);
  });
});

describe('effect behaviour', () => {
  it('colour: invert twice is identity; grayscale has equal channels', () => {
    const img = scene(32, 24);
    const inv = applyColour(applyColour(img, { invert: true }), { invert: true });
    expect(maxAbsDiff(inv, img)).toBeLessThanOrEqual(1);
    const g = applyColour(img, { grayscale: true });
    for (let i = 0; i < g.data.length; i += 4) {
      expect(g.data[i]).toBe(g.data[i + 1]);
      expect(g.data[i + 1]).toBe(g.data[i + 2]);
    }
  });
  it('colour: exposure brightens, hue 360 ≈ identity', () => {
    const img = scene(32, 24);
    const mean = (x: Img) => x.data.reduce((a, v, i) => (i % 4 === 3 ? a : a + v), 0);
    expect(mean(applyColour(img, { exposure: 1 }))).toBeGreaterThan(mean(img));
    expect(maxAbsDiff(applyColour(img, { hue: 180 }), applyColour(img, { hue: -180 }))).toBeLessThanOrEqual(1);
  });
  it('geometry: rotate 90 swaps dimensions; four rotations are identity; crop ratios hold', () => {
    const img = noise(30, 20);
    const r = applyGeometry(img, { rotate: 90 });
    expect([r.width, r.height]).toEqual([20, 30]);
    let x = img;
    for (let i = 0; i < 4; i++) x = applyGeometry(x, { rotate: 90 });
    expect(maxAbsDiff(x, img)).toBe(0);
    expect(maxAbsDiff(applyGeometry(applyGeometry(img, { rotate: 90 }), { rotate: -90 }), img)).toBe(0);
    const c = resolveCrop(1600, 900, { aspect: '1:1', cropX: 0, cropY: 0, cropW: 1, cropH: 1 });
    expect(c.w).toBe(c.h);
    expect(c.x).toBe(350);
    const s = applyGeometry(noise(40, 40), { scale: '0.25' });
    expect([s.width, s.height]).toEqual([10, 10]);
  });
  it('palette: output uses only palette colours', () => {
    const out = applyPalette(scene(40, 30), { preset: 'green', tones: 4, dither: 'floyd' });
    const pal = new Set(VIEWFINDER_PALETTES.green.map((c) => c.join(',')));
    for (let i = 0; i < out.data.length; i += 4) expect(pal.has(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`)).toBe(true);
  });
  it('palette: viewfinder presets are 4 tones dark → bright', () => {
    for (const p of Object.values(VIEWFINDER_PALETTES)) {
      expect(p).toHaveLength(4);
      const l = p.map(([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11);
      expect(l[0]).toBeLessThan(l[3]);
    }
  });
  it('pixel sort: sorted spans are monotonic in luma', () => {
    const img = noise(64, 4, 3);
    const out = applyPixelSort(img, { direction: 'h', key: 'luma', low: 0, high: 1 });
    for (let y = 0; y < 4; y++) {
      let prev = -1;
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const l = 0.299 * out.data[i] + 0.587 * out.data[i + 1] + 0.114 * out.data[i + 2];
        expect(l).toBeGreaterThanOrEqual(prev - 0.5);
        prev = l;
      }
    }
  });
  it('8-bit: median cut returns at most n colours; blocks are uniform', () => {
    expect(medianCut(scene(64, 48), 8).length).toBeLessThanOrEqual(8);
    const out = applyEightBit(scene(64, 48), { block: 8, palette: 'gameboy', dither: 'none' });
    for (let by = 0; by < 6; by++) for (let bx = 0; bx < 8; bx++) {
      const i0 = (by * 8 * 64 + bx * 8) * 4;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = ((by * 8 + y) * 64 + bx * 8 + x) * 4;
        expect(out.data[i]).toBe(out.data[i0]);
      }
    }
  });
  it('ASCII: exports text with one line per row of cells', () => {
    const def = EFFECTS.ascii;
    const ctx = newContext();
    def.apply(scene(80, 60), { ...defaultsOf(def.params), cell: 8 }, rngFor(1), ctx);
    const lines = ctx.side.asciiText!.split('\n');
    expect(lines).toHaveLength(Math.floor(60 / Math.round(8 / 0.6)));
    expect(lines[0]).toHaveLength(10);
    expect(/^[.:\-=+*#%@]+$/.test(lines.join(''))).toBe(true);
  });
  it('ASCII: brighter cells use denser characters', () => {
    const def = EFFECTS.ascii;
    const dark = newContext(), bright = newContext();
    def.apply(solid(40, 40, [10, 10, 10]), { ...defaultsOf(def.params) }, rngFor(1), dark);
    def.apply(solid(40, 40, [250, 250, 250]), { ...defaultsOf(def.params) }, rngFor(1), bright);
    expect(dark.side.asciiText![0]).toBe('.');
    expect(bright.side.asciiText![0]).toBe('@');
  });
  it('datamosh: holds a keyframe and drifts from the real frames', () => {
    const st = {};
    const a = scene(48, 48), b = solid(48, 48, [128, 128, 128]);
    run('datamosh', a, { hold: 10, rampFrom: 1, rampTo: 1 }, 1, 0, true, st);
    const out = run('datamosh', b, { hold: 10, rampFrom: 1, rampTo: 1, residual: 0 }, 1, 1, true, st);
    // with full ramp and no residual, frame 1 is built only from the held keyframe's pixels
    const colours = new Set<number>();
    const pa = new Uint32Array(a.data.buffer);
    pa.forEach((v) => colours.add(v));
    const po = new Uint32Array(out.data.buffer);
    let fromKey = 0;
    po.forEach((v) => { if (colours.has(v)) fromKey++; });
    expect(fromKey).toBe(po.length);
    expect(meanAbsDiff(out, b)).toBeGreaterThan(10);
  });
});
