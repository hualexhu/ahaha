import { describe, expect, it } from 'vitest';
import { outputName } from '../../src/core/filename';
import { defaultPipeline, normalizePipeline, resolveParams, runPipeline, type Pipeline } from '../../src/core/pipeline';
import { BUILTIN_PRESETS, exportPresetsJson, parsePresets } from '../../src/core/presets';
import { normalizeVideo, planVideo, DEFAULT_VIDEO } from '../../src/core/video';
import { RollingStack, StillStack } from '../../src/effects/stack';
import { bytesEqual, maxAbsDiff, meanAbsDiff, scene, solid } from './helpers';

describe('pipeline', () => {
  it('default pipeline is the identity', () => {
    const img = scene(40, 30);
    expect(maxAbsDiff(runPipeline(img, defaultPipeline()).img, img)).toBe(0);
  });
  it('order matters', () => {
    const img = scene(48, 32);
    const p = defaultPipeline();
    for (const e of p.effects) if (e.type === 'palette' || e.type === 'colour') e.enabled = true;
    p.effects.find((e) => e.type === 'colour')!.params.invert = true;
    const a = runPipeline(img, p).img;
    const rev: Pipeline = { ...p, effects: [...p.effects].reverse() };
    const b = runPipeline(img, rev).img;
    expect(bytesEqual(a.data, b.data)).toBe(false);
  });
  it('whole pipeline is deterministic for a seed and changes with the seed', () => {
    const img = scene(64, 48);
    const p = normalizePipeline(BUILTIN_PRESETS.find((x) => x.name === 'Heavy Glitch')!.pipeline);
    const a = runPipeline(img, p).img;
    const b = runPipeline(img, p).img;
    expect(bytesEqual(a.data, b.data)).toBe(true);
    const c = runPipeline(img, { ...p, seed: p.seed + 1 }).img;
    expect(bytesEqual(a.data, c.data)).toBe(false);
  });
  it('normalizes partial / hostile input', () => {
    const p = normalizePipeline({ seed: 5, effects: [{ type: 'palette', enabled: true, params: { tones: 6, bogus: 1, preset: 3 as unknown as string }, anim: { tones: 2, nope: 1 } }] } as unknown as Pipeline);
    expect(p.effects).toHaveLength(8);
    expect(p.effects[0].type).toBe('palette');
    expect(p.effects[0].params.tones).toBe(6);
    expect(p.effects[0].params.preset).toBe('green');
    expect('bogus' in p.effects[0].params).toBe(false);
    expect(p.effects[0].anim).toEqual({ tones: 2 });
  });
  it('parameter animation interpolates linearly and pixel params scale with preview size', () => {
    const inst = { ...defaultPipeline().effects.find((e) => e.type === 'eightbit')!, anim: { block: 20 } };
    inst.params = { ...inst.params, block: 4 };
    expect(resolveParams(inst, 0, 1).block).toBe(4);
    expect(resolveParams(inst, 0.5, 1).block).toBe(12);
    expect(resolveParams(inst, 1, 1).block).toBe(20);
    expect(resolveParams(inst, 0, 0.25).block).toBe(1);
    expect(resolveParams(inst, 1, 0.5).block).toBe(10);
  });
  it('stopAfter halts the pipeline', () => {
    const img = scene(32, 32);
    const p = defaultPipeline();
    p.effects.forEach((e) => { if (e.type === 'colour' || e.type === 'palette') e.enabled = true; });
    p.effects.find((e) => e.type === 'colour')!.params.invert = true;
    const out = runPipeline(img, p, { stopAfter: 'colour' }).img;
    const inv = runPipeline(img, { ...p, effects: p.effects.map((e) => ({ ...e, enabled: e.type === 'colour' })) }).img;
    expect(maxAbsDiff(out, inv)).toBe(0);
  });
});

describe('presets', () => {
  it('ships 6 named built-ins', () => {
    expect(BUILTIN_PRESETS.map((p) => p.name)).toEqual(['CyberShot Green', 'Heavy Glitch', 'Light Trails', 'Terminal ASCII', '8-bit Arcade', 'Noir Sort']);
  });
  it('all built-in presets produce visibly distinct results', () => {
    const img = scene(120, 80);
    const outs = BUILTIN_PRESETS.map((p) => runPipeline(img, normalizePipeline(p.pipeline)).img);
    for (let i = 0; i < outs.length; i++) {
      expect(meanAbsDiff(outs[i], img)).toBeGreaterThan(8);
      for (let j = i + 1; j < outs.length; j++) {
        const d = meanAbsDiff(outs[i], outs[j]);
        expect(d, `${BUILTIN_PRESETS[i].name} vs ${BUILTIN_PRESETS[j].name}`).toBeGreaterThan(10);
      }
    }
  });
  it('round-trips through JSON export/import', () => {
    const json = exportPresetsJson(BUILTIN_PRESETS.slice(0, 2));
    const back = parsePresets(JSON.parse(json));
    expect(back.map((p) => p.name)).toEqual(['CyberShot Green', 'Heavy Glitch']);
    expect(back[1].pipeline).toEqual(normalizePipeline(BUILTIN_PRESETS[1].pipeline));
  });
  it('ignores junk in imported JSON', () => {
    expect(parsePresets(null)).toEqual([]);
    expect(parsePresets([{ name: '' }, { foo: 1 }, 7])).toEqual([]);
    expect(parsePresets({ name: 'x' })).toHaveLength(1);
  });
});

describe('filenames', () => {
  it('follow <original>_glitchlab_<preset-or-custom>_<seed>.<ext>', () => {
    expect(outputName('holiday photo.JPG', 'CyberShot Green', 42, 'png')).toBe('holiday photo_glitchlab_cybershot-green_42.png');
    expect(outputName('clip.mp4', null, 7, 'gif')).toBe('clip_glitchlab_custom_7.gif');
    expect(outputName('a.b.c.webp', '8-bit Arcade', 1, 'jpg')).toBe('a.b.c_glitchlab_8-bit-arcade_1.jpg');
  });
});

describe('video planning', () => {
  const meta = { width: 3840, height: 2160, duration: 120, fps: 30 };
  it('caps at 1080p and 60 s with warnings', () => {
    const p = planVideo(meta, DEFAULT_VIDEO);
    expect(p.width).toBe(1920);
    expect(p.height).toBe(1080);
    expect(p.end - p.start).toBe(60);
    expect(p.frames).toBe(1800);
    expect(p.warnings).toHaveLength(2);
  });
  it('lifting the caps keeps the original', () => {
    const p = planVideo(meta, { ...DEFAULT_VIDEO, liftLimits: true });
    expect([p.width, p.height, p.frames]).toEqual([3840, 2160, 3600]);
  });
  it('applies trim, fps and speed', () => {
    const m = { width: 320, height: 240, duration: 2, fps: 15 };
    expect(planVideo(m, DEFAULT_VIDEO).frames).toBe(30);
    expect(planVideo(m, { ...DEFAULT_VIDEO, fpsMode: 'half' }).frames).toBe(15);
    expect(planVideo(m, { ...DEFAULT_VIDEO, speed: 2 }).frames).toBe(15);
    expect(planVideo(m, { ...DEFAULT_VIDEO, trimStart: 0.5, trimEnd: 1.5 }).frames).toBe(15);
    expect(planVideo(m, { ...DEFAULT_VIDEO, fpsMode: 'custom', customFps: 10 }).frames).toBe(20);
    expect(planVideo(m, DEFAULT_VIDEO, 5).frames).toBe(10);
  });
  it('normalizes settings', () => {
    const v = normalizeVideo({ speed: -3, stackWindow: 999, stackMode: 'x' as never });
    expect(v.speed).toBe(0.1);
    expect(v.stackWindow).toBe(30);
    expect(v.stackMode).toBe('lighten');
  });
});

describe('frame stacking', () => {
  const frames = [10, 200, 90].map((v) => solid(4, 4, [v, 255 - v, v]));
  it('still: average / lighten / darken', () => {
    const avg = new StillStack('average'), li = new StillStack('lighten'), da = new StillStack('darken');
    for (const f of frames) { avg.add(f); li.add(f); da.add(f); }
    expect(avg.result()!.data[0]).toBe(100);
    expect(li.result()!.data[0]).toBe(200);
    expect(li.result()!.data[1]).toBe(245);
    expect(da.result()!.data[0]).toBe(10);
    expect(avg.frames).toBe(3);
  });
  it('rolling window of 2', () => {
    const r = new RollingStack('average', 2);
    expect(r.push(frames[0]).data[0]).toBe(10);
    expect(r.push(frames[1]).data[0]).toBe(105);
    expect(r.push(frames[2]).data[0]).toBe(145);
    const l = new RollingStack('lighten', 2);
    l.push(frames[1]);
    expect(l.push(frames[2]).data[0]).toBe(200);
    expect(l.push(frames[0]).data[0]).toBe(90);
  });
  it('window 1 is the identity', () => {
    const r = new RollingStack('darken', 1);
    expect(r.push(frames[1])).toBe(frames[1]);
  });
});
