import { describe, expect, it } from 'vitest';
import { deriveSeed, mulberry32, rngFor } from '../../src/core/rng';

describe('seeded rng', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(123), b = mulberry32(123);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });
  it('differs between seeds and stays in [0,1)', () => {
    const a = mulberry32(1), b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 1000; i++) {
      const x = a.next(), y = b.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      if (x === y) same++;
    }
    expect(same).toBeLessThan(5);
  });
  it('int() covers the range uniformly-ish', () => {
    const r = mulberry32(99);
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) counts[r.int(10)]++;
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });
  it('deriveSeed mixes parts and is stable', () => {
    expect(deriveSeed(1, 'databend', 0)).toBe(deriveSeed(1, 'databend', 0));
    expect(deriveSeed(1, 'databend', 0)).not.toBe(deriveSeed(1, 'databend', 1));
    expect(deriveSeed(1, 'databend', 0)).not.toBe(deriveSeed(1, 'palette', 0));
    expect(rngFor(5, 'x').next()).toBe(rngFor(5, 'x').next());
  });
});
