/// <reference lib="webworker" />
import { createImg, type Img } from '../core/image';
import { run, readFile, removeFile, writeFile } from './ffmpeg';

/** Target raw chunk size: bounds memory while streaming through a clip. */
export const CHUNK_BYTES = 48 * 1024 * 1024;

export interface DecodeOpts {
  /** Source time of the first frame (seconds). */
  start: number;
  count: number;
  /** Output frame rate (frames are sampled every speed/fps source seconds). */
  fps: number;
  speed: number;
  width: number;
  height: number;
}

/**
 * Decode `count` frames starting at `start` into RGBA images, resampled to
 * the output frame rate and size. Returns fewer frames at the end of a clip.
 */
export async function decodeFrames(input: string, o: DecodeOpts, tag = 'dec'): Promise<Img[]> {
  const out = `${tag}.rgba`;
  const vf = [`setpts=(PTS-STARTPTS)/${o.speed.toFixed(6)}`, `fps=${o.fps.toFixed(6)}`, `scale=${o.width}:${o.height}:flags=bicubic`].join(',');
  const args = ['-ss', o.start.toFixed(6), '-i', input, '-an', '-vf', vf, '-frames:v', String(o.count), '-pix_fmt', 'rgba', '-f', 'rawvideo', out];
  await run(args);
  let raw: Uint8Array;
  try {
    raw = await readFile(out);
  } catch {
    return [];
  } finally {
    await removeFile(out);
  }
  const size = o.width * o.height * 4;
  const frames: Img[] = [];
  for (let off = 0; off + size <= raw.length && frames.length < o.count; off += size) {
    frames.push({ width: o.width, height: o.height, data: new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + size)) });
  }
  return frames;
}

export type VideoFormat = 'mp4' | 'webm' | 'gif';

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

/** Encode a chunk of frames to a segment file; returns its path. */
export async function encodeSegment(frames: Img[], index: number, fps: number, format: VideoFormat): Promise<string> {
  const { width, height } = frames[0];
  const size = width * height * 4;
  const raw = new Uint8Array(size * frames.length);
  frames.forEach((f, i) => raw.set(f.data, i * size));
  const rawPath = `seg${index}.rgba`;
  await writeFile(rawPath, raw);
  const input = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', fps.toFixed(6), '-i', rawPath];
  let path: string;
  let codec: string[];
  if (format === 'webm') {
    path = `seg${index}.webm`;
    codec = ['-c:v', 'libvpx', '-b:v', '0', '-crf', '8', '-qmin', '0', '-qmax', '40', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'];
  } else {
    path = `seg${index}.mp4`;
    // GIF path uses a high-quality intermediate
    const crf = format === 'gif' ? '12' : '20';
    codec = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-pix_fmt', 'yuv420p', '-g', String(Math.max(1, Math.round(fps)))];
  }
  const { code, log } = await run([...input, ...codec, path]);
  await removeFile(rawPath);
  if (code !== 0) throw new Error(`encoder failed (${format}): ${log.slice(-3).join(' ')}`);
  return path;
}

/** Join segments without re-encoding; GIF gets a palette-optimised final pass. */
export async function finishVideo(segments: string[], format: VideoFormat, fps: number, gifWidth?: number): Promise<Uint8Array> {
  const list = segments.map((s) => `file '${s}'`).join('\n');
  await writeFile('list.txt', new TextEncoder().encode(list));
  const joined = format === 'webm' ? 'joined.webm' : 'joined.mp4';
  const concatArgs = ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy'];
  if (format === 'mp4') concatArgs.push('-movflags', '+faststart');
  const r1 = await run([...concatArgs, joined]);
  for (const s of segments) await removeFile(s);
  await removeFile('list.txt');
  if (r1.code !== 0) throw new Error('could not join video segments');
  if (format !== 'gif') {
    const data = await readFile(joined);
    await removeFile(joined);
    return data;
  }
  const scale = gifWidth ? `scale=${gifWidth}:-2:flags=lanczos,` : '';
  const vf = `fps=${fps.toFixed(6)},${scale}split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const r2 = await run(['-i', joined, '-filter_complex', vf, '-loop', '0', 'out.gif']);
  await removeFile(joined);
  if (r2.code !== 0) throw new Error('GIF encoding failed');
  const data = await readFile('out.gif');
  await removeFile('out.gif');
  return data;
}
