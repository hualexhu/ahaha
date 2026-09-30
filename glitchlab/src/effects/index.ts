import { asciiEffect } from './ascii';
import { colourEffect } from './colour';
import { databendEffect } from './databend';
import { datamoshEffect } from './datamosh';
import { eightBitEffect } from './eightbit';
import { geometryEffect } from './geometry';
import { paletteEffect } from './palette';
import { pixelSortEffect } from './pixelsort';
import type { EffectDef, EffectType } from './types';

export const EFFECTS: Record<EffectType, EffectDef> = {
  geometry: geometryEffect,
  colour: colourEffect,
  datamosh: datamoshEffect,
  databend: databendEffect,
  pixelsort: pixelSortEffect,
  eightbit: eightBitEffect,
  palette: paletteEffect,
  ascii: asciiEffect,
};

/** Default pipeline order. */
export const DEFAULT_ORDER: EffectType[] = ['geometry', 'colour', 'datamosh', 'databend', 'pixelsort', 'eightbit', 'palette', 'ascii'];
