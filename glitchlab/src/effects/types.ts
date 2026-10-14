import type { Img } from '../core/image';
import type { Rng } from '../core/rng';

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

interface ParamBase {
  key: string;
  label: string;
  help?: string;
  /** Only show this control when the predicate holds. */
  visibleIf?: (p: Params) => boolean;
}

export interface RangeParam extends ParamBase {
  kind: 'range';
  min: number;
  max: number;
  step: number;
  default: number;
  /** Pixel-unit parameter: scaled with the preview/export resolution. */
  pixels?: boolean;
  /** Integer-valued (rounded after animation). */
  int?: boolean;
  unit?: string;
}
export interface SelectParam extends ParamBase {
  kind: 'select';
  options: { value: string; label: string }[];
  default: string;
}
export interface ToggleParam extends ParamBase {
  kind: 'toggle';
  default: boolean;
}
export interface ColorParam extends ParamBase {
  kind: 'color';
  default: string;
}
export interface TextParam extends ParamBase {
  kind: 'text';
  default: string;
  maxLength?: number;
}
/** Comma separated list of #rrggbb colours. */
export interface ColorsParam extends ParamBase {
  kind: 'colors';
  default: string;
  min: number;
  max: number;
}

export type ParamSpec = RangeParam | SelectParam | ToggleParam | ColorParam | TextParam | ColorsParam;

/** Glyph coverage masks for the ASCII effect; provided by the host (canvas in the browser, synthetic in tests). */
export interface GlyphAtlas {
  cellW: number;
  cellH: number;
  /** One mask of cellW*cellH coverage values (0..1) per character. */
  masks: Float32Array[];
}

export interface EffectContext {
  /** Resolution scale relative to full-size export (preview < 1). Pixel params are multiplied by it. */
  scale: number;
  /** Index of the frame being processed (0 for stills). */
  frameIndex: number;
  /** Normalised clip position 0..1 (0 for stills). */
  t: number;
  /** Whether the source is a video (temporal effects are no-ops on stills). */
  isVideo: boolean;
  /** Persistent per-effect state across frames of one render job. */
  state: Record<string, unknown>;
  /** Provides glyph masks for the ASCII effect. */
  glyphs?: (chars: string[], cellW: number, cellH: number) => GlyphAtlas;
  /** Side outputs (ASCII text, glitched JPEG bytes). */
  side: SideOutputs;
}

export interface SideOutputs {
  asciiText?: string;
  jpegBytes?: Uint8Array;
  /** Human-readable notes (e.g. databend retries). */
  notes: string[];
}

export interface EffectDef {
  type: EffectType;
  label: string;
  description: string;
  params: ParamSpec[];
  /** Only meaningful on video (datamosh). */
  videoOnly?: boolean;
  apply(img: Img, params: Params, rng: Rng, ctx: EffectContext): Img;
}

export type EffectType =
  | 'geometry'
  | 'colour'
  | 'datamosh'
  | 'databend'
  | 'pixelsort'
  | 'eightbit'
  | 'palette'
  | 'ascii';

export function num(p: Params, k: string, fallback = 0): number {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export function bool(p: Params, k: string): boolean {
  return p[k] === true;
}
export function str(p: Params, k: string, fallback = ''): string {
  const v = p[k];
  return typeof v === 'string' ? v : fallback;
}

export function defaultsOf(specs: ParamSpec[]): Params {
  const out: Params = {};
  for (const s of specs) out[s.key] = s.default;
  return out;
}

export const mixParam: RangeParam = {
  kind: 'range', key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, default: 1,
  help: 'Blend between the input (0) and the effect (1).',
};

export function newContext(partial: Partial<EffectContext> = {}): EffectContext {
  return {
    scale: 1,
    frameIndex: 0,
    t: 0,
    isVideo: false,
    state: {},
    side: { notes: [] },
    ...partial,
  };
}
