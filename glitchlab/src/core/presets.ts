import type { EffectType, Params } from '../effects/types';
import { defaultPipeline, normalizePipeline, type Pipeline } from './pipeline';
import { normalizeVideo, type VideoSettings } from './video';

export interface Preset {
  name: string;
  builtin?: boolean;
  pipeline: Pipeline;
  video?: Partial<VideoSettings>;
}

type Overrides = Partial<Record<EffectType, Params>>;

/** Build a pipeline from the default one: listed effects are enabled with the given param overrides, in `order` if given. */
function make(seed: number, on: Overrides, order?: EffectType[]): Pipeline {
  const p = defaultPipeline(seed);
  for (const e of p.effects) {
    const o = on[e.type];
    if (o) {
      e.enabled = true;
      Object.assign(e.params, o);
    }
  }
  if (order) {
    const rank = (t: EffectType): number => {
      const i = order.indexOf(t);
      return i < 0 ? 100 + p.effects.findIndex((e) => e.type === t) : i;
    };
    p.effects.sort((a, b) => rank(a.type) - rank(b.type));
  }
  return p;
}

export const BUILTIN_PRESETS: Preset[] = [
  {
    name: 'CyberShot Green',
    builtin: true,
    pipeline: make(4444, {
      colour: { exposure: 0.35, contrast: 0.2 },
      databend: { quality: 50, dqtOn: false, scanOn: true, scan: 0.15, scanBytes: 4, scanStart: 0.2, chromaOn: false },
      palette: { preset: 'green', tones: 4, dither: 'bayer', contrast: 0 },
    }),
  },
  {
    name: 'Heavy Glitch',
    builtin: true,
    pipeline: make(9001, {
      colour: { saturation: 0.35, contrast: 0.1 },
      databend: {
        quality: 45, dqtOn: true, dqt: 0.5, dqtLowCut: 5, dqtHighCut: 36,
        dhtOn: true, dht: 0.6, scanOn: true, scan: 0.6, scanBytes: 10, scanStart: 0.15, scanEnd: 0.9,
        chromaOn: true, chroma: 0.6, zigzagOn: false,
      },
    }),
  },
  {
    name: 'Light Trails',
    builtin: true,
    pipeline: make(2718, {
      colour: { exposure: -0.6, contrast: 0.45, saturation: 0.5, hue: -12 },
      pixelsort: { direction: 'v', key: 'luma', low: 0.3, high: 1, reverse: true },
    }),
    video: { stackOn: true, stackMode: 'lighten', stackWindow: 12, stackOutput: 'rolling' },
  },
  {
    name: 'Terminal ASCII',
    builtin: true,
    pipeline: make(1981, {
      colour: { contrast: 0.35, exposure: 0.4 },
      ascii: { charset: 'classic', cell: 9, colorMode: 'green', background: '#001206' },
    }),
  },
  {
    name: '8-bit Arcade',
    builtin: true,
    pipeline: make(1985, {
      colour: { saturation: 0.45, contrast: 0.25 },
      eightbit: { block: 8, palette: 'median', colors: 12, dither: 'bayer' },
    }),
  },
  {
    name: 'Noir Sort',
    builtin: true,
    pipeline: make(1947, {
      colour: { noir: true, contrast: 0.1 },
      pixelsort: { direction: 'h', key: 'luma', low: 0.3, high: 0.85, reverse: false },
    }, ['geometry', 'colour', 'pixelsort']),
  },
];

const STORAGE_KEY = 'glitchlab.presets.v1';

export function loadUserPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return parsePresets(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveUserPresets(list: Preset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.filter((p) => !p.builtin)));
  } catch {
    /* storage full or disabled: presets stay in memory */
  }
}

/** Validate/normalise presets from untrusted JSON (a single preset or an array). */
export function parsePresets(data: unknown): Preset[] {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' && 'presets' in data ? (data as { presets: unknown }).presets : [data];
  if (!Array.isArray(arr)) return [];
  const out: Preset[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Partial<Preset>;
    if (typeof o.name !== 'string' || !o.name.trim()) continue;
    out.push({
      name: o.name.trim().slice(0, 60),
      pipeline: normalizePipeline(o.pipeline),
      video: o.video ? normalizeVideo(o.video) : undefined,
    });
  }
  return out;
}

export function exportPresetsJson(list: Preset[]): string {
  return JSON.stringify({ app: 'glitchlab', version: 1, presets: list.map(({ name, pipeline, video }) => ({ name, pipeline, video })) }, null, 2);
}
