/**
 * Seeded pseudo-random number generation. Every random decision in GlitchLab
 * goes through one of these so that same input + params + seed = same bytes.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform float in [a, b). */
  range(a: number, b: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
}

/** mulberry32: tiny 32-bit generator with good statistical quality for visual work. */
export function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (a, b) => a + (b - a) * next(),
    chance: (p) => next() < p,
  };
}

/** Mix several values (numbers or strings) into one 32-bit seed (FNV-1a style + avalanche). */
export function deriveSeed(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  const feed = (byte: number): void => {
    h ^= byte & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  for (const p of parts) {
    if (typeof p === 'number') {
      const v = Math.floor(p) >>> 0;
      feed(v); feed(v >>> 8); feed(v >>> 16); feed(v >>> 24);
    } else {
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        feed(c); feed(c >>> 8);
      }
    }
    feed(0x5a);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export const rngFor = (...parts: (number | string)[]): Rng => mulberry32(deriveSeed(...parts));

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}
