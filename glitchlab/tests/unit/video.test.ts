import { describe, expect, it } from 'vitest';
import { parseLastTime, parseProbe, rgbaToI420, vp8Crf, x264Crf } from '../../src/worker/video';
import { solid } from './helpers';

describe('RGBA → YUV 4:2:0 (BT.709, limited range)', () => {
  const yuv = (c: [number, number, number]) => {
    const dst = new Uint8Array(4 * 4 * 1.5);
    rgbaToI420(solid(4, 4, c), dst, 0);
    return [dst[0], dst[16], dst[20]];
  };
  it('maps black, white and grey to the limited range with neutral chroma', () => {
    expect(yuv([0, 0, 0])).toEqual([16, 128, 128]);
    expect(yuv([255, 255, 255])).toEqual([235, 128, 128]);
    const g = yuv([128, 128, 128]);
    expect(g[0]).toBeGreaterThan(120);
    expect(g[0]).toBeLessThan(130);
    expect(g.slice(1)).toEqual([128, 128]);
  });
  it('matches BT.709 for primaries', () => {
    const [y, u, v] = yuv([255, 0, 0]);
    expect(y).toBeGreaterThanOrEqual(62);
    expect(y).toBeLessThanOrEqual(64);
    expect(u).toBeGreaterThanOrEqual(101);
    expect(u).toBeLessThanOrEqual(103);
    expect(v).toBe(240);
  });
  it('writes at an offset without touching other frames', () => {
    const dst = new Uint8Array(2 * 24).fill(7);
    rgbaToI420(solid(4, 4, [255, 255, 255]), dst, 24);
    expect(dst.subarray(0, 24).every((x) => x === 7)).toBe(true);
    expect(dst[24]).toBe(235);
  });
});

describe('ffmpeg -i log parsing (fallback probe)', () => {
  it('reads size, fps, duration and swaps sides for 90° rotation', () => {
    const log = [
      '  Duration: 00:00:06.00, start: 0.000000, bitrate: 6232 kb/s',
      '  Stream #0:0[0x1](eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 6147 kb/s, 29.97 fps, 30 tbr, 15360 tbn (default)',
      '    Side data:',
      '      displaymatrix: rotation of -90.00 degrees',
    ];
    expect(parseProbe(log)).toEqual({ width: 1080, height: 1920, duration: 6, fps: 29.97 });
  });
  it('returns null without a video stream', () => {
    expect(parseProbe(['  Stream #0:0: Audio: aac'])).toBeNull();
  });
});

describe('video quality → encoder CRF', () => {
  it('maps the default 0.75 to x264 CRF 23 and stays in a sane range', () => {
    expect(x264Crf(0.75)).toBe(23);
    expect(x264Crf(1)).toBe(19);
    expect(x264Crf(0)).toBe(35);
    expect(x264Crf(5)).toBe(19);
    expect(vp8Crf(1)).toBe(8);
    expect(vp8Crf(0.75)).toBe(16);
  });
});

describe('parseLastTime', () => {
  it('takes the furthest time= of a progress log', () => {
    expect(parseLastTime(['frame=  10 fps=0.0 q=-1.0 size=N/A time=00:00:01.50 bitrate=N/A', 'frame=  99 fps=0.0 q=-1.0 Lsize=N/A time=00:01:03.96 bitrate=N/A speed= 300x'])).toBeCloseTo(63.96, 6);
  });
  it('is 0 without progress lines', () => {
    expect(parseLastTime(['Input #0, matroska,webm, from x:', 'time=N/A'])).toBe(0);
  });
});
