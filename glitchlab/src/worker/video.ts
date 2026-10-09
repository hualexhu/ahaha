/// <reference lib="webworker" />
import { createImg, type Img } from '../core/image';
import type { VideoMeta } from '../core/video';
import { FFInstance, type DeviceOps } from './ffmpeg';

export type VideoFormat = 'mp4' | 'webm' | 'gif';

// ---------------------------------------------------------------- probing

/** Parse duration / size / fps / rotation from `ffmpeg -i` output (fallback when ffprobe JSON is unavailable). */
export function parseProbe(log: string[]): VideoMeta | null {
  const text = log.join('\n');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const vid = /Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
  if (!vid) return null;
  let width = parseInt(vid[1], 10);
  let height = parseInt(vid[2], 10);
  const line = vid[0];
  const fpsM = /([\d.]+)\s*fps/.exec(line) ?? /([\d.]+)\s*tbr/.exec(line);
  const fps = fpsM ? parseFloat(fpsM[1]) : 30;
  const rot = /rotate\s*:\s*(-?\d+)/.exec(text) ?? /rotation of (-?[\d.]+) degrees/.exec(text);
  if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) [width, height] = [height, width];
  const duration = dur ? parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3]) : 0;
  return { width, height, duration, fps: fps > 0 && fps < 1000 ? fps : 30 };
}

const ratio = (r: unknown): number => {
  if (typeof r !== 'string') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a || 0;
};

interface ProbeStream {
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

/** Read size, frame rate, duration and rotation with ffprobe's JSON output. */
export function probeVideo(ff: FFInstance, path: string): VideoMeta {
  const { log } = ff.probe(['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-select_streams', 'v:0', path]);
  const text = log.join('\n');
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { streams?: ProbeStream[]; format?: { duration?: string } };
    const s = json.streams?.[0];
    if (s?.width && s.height) {
      let width = s.width, height = s.height;
      const rot = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? parseFloat(s.tags?.rotate ?? '0');
      if (Math.abs(Math.round(rot)) % 180 === 90) [width, height] = [height, width];
      const avg = ratio(s.avg_frame_rate), r = ratio(s.r_frame_rate);
      const fps = avg > 0 && avg < 1000 ? avg : r > 0 && r < 1000 ? r : 30;
      const duration = parseFloat(s.duration ?? json.format?.duration ?? '0') || 0;
      return { width, height, fps, duration };
    }
  } catch {
    /* fall through to the log parser */
  }
  const meta = parseProbe(ff.run(['-i', path]).log);
  if (!meta) throw new Error('Could not read this video (unsupported codec or container).');
  return meta;
}

// ---------------------------------------------------------------- decoding

export interface DecodeOpts {
  /** Source time of the first frame (seconds). */
  start: number;
  /** Source seconds to read (0 = to the end). */
  duration?: number;
  count: number;
  /** Output frame rate (frames are sampled every speed/fps source seconds). */
  fps: number;
  speed: number;
  width: number;
  height: number;
}

function decodeArgs(input: string, o: DecodeOpts, output: string): string[] {
  const vf = [`setpts=(PTS-STARTPTS)/${o.speed.toFixed(6)}`, `fps=${o.fps.toFixed(6)}`, `scale=${o.width}:${o.height}:flags=bicubic`].join(',');
  const seek = o.start > 0 ? ['-ss', o.start.toFixed(6)] : [];
  const dur = o.duration && o.duration > 0 ? ['-t', o.duration.toFixed(6)] : [];
  return [...seek, ...dur, '-i', input, '-an', '-sn', '-dn', '-vf', vf, '-frames:v', String(o.count), '-pix_fmt', 'rgba', '-f', 'rawvideo', output];
}

/** Decode a few frames into memory (previews, single-frame exports). */
export function decodeFrames(ff: FFInstance, input: string, o: DecodeOpts): Img[] {
  const out = '/tmp_frames.rgba';
  ff.run(decodeArgs(input, o, out));
  if (!ff.exists(out)) return [];
  const raw = ff.readAndRemove(out);
  const size = o.width * o.height * 4;
  const frames: Img[] = [];
  for (let off = 0; off + size <= raw.length && frames.length < o.count; off += size) {
    frames.push({ width: o.width, height: o.height, data: new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + size)) });
  }
  return frames;
}

let deviceSeq = 0;

/**
 * Decode a whole range in ONE sequential ffmpeg run (no re-seeking, so long
 * keyframe intervals cost nothing extra). Frames are handed to `onFrame` the
 * moment ffmpeg writes them: ffmpeg's output is a character device whose
 * write handler assembles frames. `onFrame` runs synchronously inside the run.
 * Returns the number of frames delivered.
 */
export function streamFrames(ff: FFInstance, input: string, o: DecodeOpts, onFrame: (img: Img, index: number) => void): number {
  const frameBytes = o.width * o.height * 4;
  let buf = new Uint8ClampedArray(frameBytes);
  let fill = 0;
  let index = 0;
  const ops: DeviceOps = {
    open() {},
    close() {},
    read() {
      return 0;
    },
    write(_stream, buffer, offset, length) {
      let o2 = offset;
      let left = length;
      while (left > 0) {
        const n = Math.min(left, frameBytes - fill);
        buf.set(buffer.subarray(o2, o2 + n), fill);
        fill += n;
        o2 += n;
        left -= n;
        if (fill === frameBytes) {
          const img: Img = { width: o.width, height: o.height, data: buf };
          buf = new Uint8ClampedArray(frameBytes);
          fill = 0;
          onFrame(img, index++);
        }
      }
      return length;
    },
  };
  const fs = ff.fs;
  const dev = fs.makedev(64, ++deviceSeq % 256);
  fs.registerDevice(dev, ops);
  const path = `/frames_${deviceSeq}`;
  fs.mkdev(path, dev);
  const { code, log } = ff.run(decodeArgs(input, o, path));
  ff.remove(path);
  if (code !== 0 && index === 0) throw new Error(`Could not decode this video: ${log.slice(-2).join(' ')}`);
  return index;
}

// ---------------------------------------------------------------- encoding

/** Crop to even dimensions (required by yuv420p encoders). */
export function evenize(img: Img): Img {
  const w = img.width & ~1 || 2;
  const h = img.height & ~1 || 2;
  if (w === img.width && h === img.height) return img;
  const out = createImg(w, h);
  for (let y = 0; y < Math.min(h, img.height); y++) {
    out.data.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + Math.min(w, img.width) * 4), y * w * 4);
  }
  return out;
}

/** RGBA → planar YUV 4:2:0, BT.709 limited range (written into `dst` at `offset`). */
export function rgbaToI420(img: Img, dst: Uint8Array, offset: number): void {
  const { width: W, height: H, data: d } = img;
  const ySize = W * H;
  const cw = W >> 1;
  const uOff = offset + ySize;
  const vOff = uOff + (ySize >> 2);
  for (let y = 0; y < H; y++) {
    let i = y * W * 4;
    let o = offset + y * W;
    for (let x = 0; x < W; x++, i += 4) {
      dst[o++] = 16 + ((47 * d[i] + 157 * d[i + 1] + 16 * d[i + 2] + 128) >> 8);
    }
  }
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i0 = (y * W + x) * 4;
      const i1 = i0 + W * 4;
      const r = (d[i0] + d[i0 + 4] + d[i1] + d[i1 + 4]) >> 2;
      const g = (d[i0 + 1] + d[i0 + 5] + d[i1 + 1] + d[i1 + 5]) >> 2;
      const b = (d[i0 + 2] + d[i0 + 6] + d[i1 + 2] + d[i1 + 6]) >> 2;
      const c = (y >> 1) * cw + (x >> 1);
      dst[uOff + c] = 128 + ((-26 * r - 86 * g + 112 * b + 128) >> 8);
      dst[vOff + c] = 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
    }
  }
}

/**
 * Quality 0..1 → x264 CRF. 0.75 → 23 (x264's default). Glitched, dithered
 * footage is expensive to encode: at 1080p, CRF 20 measured ~42 Mbit/s,
 * CRF 23 ~30 Mbit/s, CRF 26 ~19 Mbit/s.
 */
export const x264Crf = (q: number): number => Math.round(35 - 16 * Math.max(0, Math.min(1, q)));
/** Quality 0..1 → libvpx (VP8) CRF, 0.75 → 16. */
export const vp8Crf = (q: number): number => Math.round(40 - 32 * Math.max(0, Math.min(1, q)));

const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

/**
 * Collects processed frames as YUV 4:2:0 and encodes them in batches with its
 * own ffmpeg instance (separate from the decoding one), keeping memory
 * bounded. Each batch becomes one segment; `finish` joins them.
 */
export class SegmentEncoder {
  readonly segments: Uint8Array[] = [];
  private batch: Uint8Array | null = null;
  private inBatch = 0;
  private readonly frameBytes: number;
  readonly batchFrames: number;

  constructor(
    private readonly ff: FFInstance,
    readonly width: number,
    readonly height: number,
    private readonly fps: number,
    private readonly format: VideoFormat,
    /** 0..1; mapped to CRF. */
    private readonly quality = 0.75,
    budgetBytes = 96 * 1024 * 1024,
  ) {
    this.frameBytes = (width * height * 3) >> 1;
    this.batchFrames = Math.max(1, Math.min(150, Math.floor(budgetBytes / this.frameBytes)));
  }

  /** Add a frame (must already be width×height). Returns true when this call encoded a batch. */
  add(img: Img, beforeEncode?: () => void): boolean {
    if (!this.batch) this.batch = new Uint8Array(this.batchFrames * this.frameBytes);
    rgbaToI420(img, this.batch, this.inBatch * this.frameBytes);
    this.inBatch++;
    if (this.inBatch < this.batchFrames) return false;
    beforeEncode?.();
    this.flush();
    return true;
  }

  flush(): void {
    if (!this.batch || this.inBatch === 0) return;
    const data = this.inBatch === this.batchFrames ? this.batch : this.batch.slice(0, this.inBatch * this.frameBytes);
    this.batch = null;
    this.inBatch = 0;
    const n = this.segments.length;
    const input = `/batch_${n}.yuv`;
    this.ff.writeOwned(input, data);
    const fps = this.fps.toFixed(6);
    const ext = this.format === 'webm' ? 'webm' : 'mp4';
    const output = `/seg_${n}.${ext}`;
    const codec = this.format === 'webm'
      ? ['-c:v', 'libvpx', '-b:v', '0', '-crf', String(vp8Crf(this.quality)), '-qmin', '0', '-qmax', '50', '-deadline', 'realtime', '-cpu-used', '8']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', this.format === 'gif' ? '14' : String(x264Crf(this.quality)), '-g', String(Math.max(1, Math.round(this.fps)))];
    const { code, log } = this.ff.run([
      '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${this.width}x${this.height}`, '-framerate', fps, '-i', input,
      ...codec, '-pix_fmt', 'yuv420p', ...COLOR_TAGS, output,
    ]);
    this.ff.remove(input);
    if (code !== 0 || !this.ff.exists(output)) throw new Error(`Encoding failed (${this.format}): ${log.slice(-2).join(' ')}`);
    this.segments.push(this.ff.readAndRemove(output));
  }
}

/** Join encoded segments without re-encoding; GIF gets a palette-optimised final pass. */
export function finishVideo(ff: FFInstance, segments: Uint8Array[], format: VideoFormat, fps: number): Uint8Array {
  const ext = format === 'webm' ? 'webm' : 'mp4';
  const names = segments.map((s, i) => {
    const name = `/part_${i}.${ext}`;
    ff.writeOwned(name, s);
    return name;
  });
  ff.writeOwned('/list.txt', new TextEncoder().encode(names.map((n) => `file '${n}'`).join('\n')));
  const joined = `/joined.${ext}`;
  const concat = ['-f', 'concat', '-safe', '0', '-i', '/list.txt', '-c', 'copy'];
  if (format === 'mp4') concat.push('-movflags', '+faststart');
  const r1 = ff.run([...concat, joined]);
  names.forEach((n) => ff.remove(n));
  ff.remove('/list.txt');
  if (r1.code !== 0 || !ff.exists(joined)) throw new Error('Could not join the video segments.');
  if (format !== 'gif') return ff.readAndRemove(joined);
  const vf = `fps=${fps.toFixed(6)},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const r2 = ff.run(['-i', joined, '-filter_complex', vf, '-loop', '0', '/out.gif']);
  ff.remove(joined);
  if (r2.code !== 0 || !ff.exists('/out.gif')) throw new Error('GIF encoding failed.');
  return ff.readAndRemove('/out.gif');
}
