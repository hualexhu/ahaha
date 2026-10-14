import { EFFECTS, DEFAULT_ORDER } from '../effects';
import { defaultsOf, newContext, type EffectContext, type EffectType, type GlyphAtlas, type Params, type SideOutputs } from '../effects/types';
import type { Img } from './image';
import { rngFor } from './rng';

export interface EffectInstance {
  type: EffectType;
  enabled: boolean;
  params: Params;
  /** Animated numeric params: value goes from params[key] (clip start) to anim[key] (clip end). */
  anim: Record<string, number>;
}

export interface Pipeline {
  seed: number;
  effects: EffectInstance[];
}

export function defaultInstance(type: EffectType, enabled = false): EffectInstance {
  return { type, enabled, params: defaultsOf(EFFECTS[type].params), anim: {} };
}

export function defaultPipeline(seed = 1337): Pipeline {
  return { seed, effects: DEFAULT_ORDER.map((t) => defaultInstance(t)) };
}

/**
 * Bring a (possibly partial or older) pipeline into canonical shape: every
 * effect exactly once, unknown params dropped, missing ones defaulted.
 */
export function normalizePipeline(p: Partial<Pipeline> | undefined): Pipeline {
  const seed = typeof p?.seed === 'number' && Number.isFinite(p.seed) ? Math.floor(p.seed) : 1337;
  const seen = new Set<EffectType>();
  const effects: EffectInstance[] = [];
  for (const e of p?.effects ?? []) {
    if (!e || !(e.type in EFFECTS) || seen.has(e.type)) continue;
    seen.add(e.type);
    const def = EFFECTS[e.type];
    const params = defaultsOf(def.params);
    for (const s of def.params) {
      const v = e.params?.[s.key];
      if (v !== undefined && typeof v === typeof s.default) params[s.key] = v;
    }
    const anim: Record<string, number> = {};
    for (const [k, v] of Object.entries(e.anim ?? {})) {
      if (typeof v === 'number' && def.params.some((s) => s.key === k && s.kind === 'range')) anim[k] = v;
    }
    effects.push({ type: e.type, enabled: !!e.enabled, params, anim });
  }
  for (const t of DEFAULT_ORDER) if (!seen.has(t)) effects.push(defaultInstance(t));
  return { seed, effects };
}

/** Resolve params for time t (0..1) and resolution scale. */
export function resolveParams(inst: EffectInstance, t: number, scale: number): Params {
  const def = EFFECTS[inst.type];
  const out: Params = { ...inst.params };
  for (const s of def.params) {
    if (s.kind !== 'range') continue;
    let v = out[s.key] as number;
    const to = inst.anim[s.key];
    if (typeof to === 'number') v = v + (to - v) * t;
    if (s.pixels) v = Math.max(s.min === 0 ? 0 : 1, v * scale);
    if (s.int) v = Math.round(v);
    out[s.key] = v;
  }
  return out;
}

export interface RunOptions {
  scale?: number;
  frameIndex?: number;
  t?: number;
  isVideo?: boolean;
  /** Per-effect persistent state (keep the same object across frames of one job). */
  states?: Partial<Record<EffectType, Record<string, unknown>>>;
  glyphs?: (chars: string[], cellW: number, cellH: number) => GlyphAtlas;
  /** Skip these effect types (e.g. geometry while editing the crop). */
  skip?: EffectType[];
  /** Stop after this effect has run (used to warm up temporal state cheaply). */
  stopAfter?: EffectType;
}

export interface RunResult {
  img: Img;
  side: SideOutputs;
}

export function runPipeline(input: Img, pipeline: Pipeline, opts: RunOptions = {}): RunResult {
  const side: SideOutputs = { notes: [] };
  const states = opts.states ?? {};
  let img = input;
  for (const inst of pipeline.effects) {
    if (!inst.enabled || opts.skip?.includes(inst.type)) continue;
    const def = EFFECTS[inst.type];
    if (def.videoOnly && !opts.isVideo) continue;
    const state = (states[inst.type] ??= {});
    const ctx: EffectContext = newContext({
      scale: opts.scale ?? 1,
      frameIndex: opts.frameIndex ?? 0,
      t: opts.t ?? 0,
      isVideo: !!opts.isVideo,
      state,
      glyphs: opts.glyphs,
      side,
    });
    const params = resolveParams(inst, ctx.t, ctx.scale);
    const rng = rngFor(pipeline.seed, inst.type, ctx.frameIndex);
    img = def.apply(img, params, rng, ctx);
    if (opts.stopAfter === inst.type) break;
  }
  return { img, side };
}

export function hasEnabled(p: Pipeline, type: EffectType): boolean {
  return p.effects.some((e) => e.type === type && e.enabled);
}
