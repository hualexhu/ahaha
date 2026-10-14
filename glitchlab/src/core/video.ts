import type { StackMode } from '../effects/stack';

export interface VideoSettings {
  trimStart: number;
  /** Seconds; 0 or less means "end of clip". */
  trimEnd: number;
  fpsMode: 'original' | 'half' | 'custom';
  customFps: number;
  speed: number;
  stackOn: boolean;
  stackMode: StackMode;
  stackWindow: number;
  stackOutput: 'rolling' | 'still';
  /** Lift the default 1080p / 60 s safety caps. */
  liftLimits: boolean;
}

export const DEFAULT_VIDEO: VideoSettings = {
  trimStart: 0,
  trimEnd: 0,
  fpsMode: 'original',
  customFps: 12,
  speed: 1,
  stackOn: false,
  stackMode: 'lighten',
  stackWindow: 8,
  stackOutput: 'rolling',
  liftLimits: false,
};

export const MAX_STACK_WINDOW = 30;
export const LIMIT_SECONDS = 60;
export const LIMIT_W = 1920;
export const LIMIT_H = 1080;

export function normalizeVideo(v: Partial<VideoSettings> | undefined): VideoSettings {
  const o = { ...DEFAULT_VIDEO, ...(v ?? {}) };
  o.speed = Math.max(0.1, Math.min(8, Number(o.speed) || 1));
  o.customFps = Math.max(1, Math.min(60, Number(o.customFps) || 12));
  o.stackWindow = Math.max(1, Math.min(MAX_STACK_WINDOW, Math.round(Number(o.stackWindow) || 1)));
  if (!['average', 'lighten', 'darken'].includes(o.stackMode)) o.stackMode = 'lighten';
  if (!['rolling', 'still'].includes(o.stackOutput)) o.stackOutput = 'rolling';
  if (!['original', 'half', 'custom'].includes(o.fpsMode)) o.fpsMode = 'original';
  o.trimStart = Math.max(0, Number(o.trimStart) || 0);
  o.trimEnd = Math.max(0, Number(o.trimEnd) || 0);
  return o;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
  fps: number;
}

export interface VideoPlan {
  /** Source seconds */
  start: number;
  end: number;
  outFps: number;
  frames: number;
  /** Processing size (even, capped). */
  width: number;
  height: number;
  warnings: string[];
}

/** Work out what an export will actually do, applying the default safety caps. */
export function planVideo(meta: VideoMeta, v: VideoSettings, fpsOverride?: number): VideoPlan {
  const warnings: string[] = [];
  const start = Math.min(Math.max(0, v.trimStart), Math.max(0, meta.duration - 0.01));
  let end = v.trimEnd > start ? Math.min(v.trimEnd, meta.duration) : meta.duration;
  if (!v.liftLimits && end - start > LIMIT_SECONDS) {
    end = start + LIMIT_SECONDS;
    warnings.push(`Clip is longer than ${LIMIT_SECONDS} s: only the first ${LIMIT_SECONDS} s after the trim start will be processed.`);
  }
  const srcFps = meta.fps > 0 ? meta.fps : 30;
  let outFps = v.fpsMode === 'half' ? srcFps / 2 : v.fpsMode === 'custom' ? v.customFps : srcFps;
  if (fpsOverride) outFps = fpsOverride;
  outFps = Math.max(1, Math.min(60, outFps));
  const frames = Math.max(1, Math.floor(((end - start) / v.speed) * outFps + 1e-6));
  let width = meta.width;
  let height = meta.height;
  if (!v.liftLimits) {
    const s = Math.min(1, LIMIT_W / Math.max(width, height), LIMIT_H / Math.min(width, height));
    if (s < 1) {
      warnings.push(`Video is larger than 1080p: it will be processed at ${Math.round(width * s)}×${Math.round(height * s)}.`);
      width *= s;
      height *= s;
    }
  }
  width = Math.max(2, Math.floor(width / 2) * 2);
  height = Math.max(2, Math.floor(height / 2) * 2);
  return { start, end, outFps, frames, width, height, warnings };
}
